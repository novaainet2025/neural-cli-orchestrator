/**
 * Nova Government — Audit & Protection Routes
 * Phase 6: 감사 로그 / 무결성 검증 / 비상 정지 / 블랙리스트
 */

import type { FastifyInstance } from 'fastify';
import {
  appendAudit,
  queryAuditLog,
  verifyChainIntegrity,
  verifyEntry,
  type AuditAction,
  type AuditSeverity,
} from '../../audit/merkleLog.js';
import {
  getActiveEmergencyStop,
  triggerEmergencyStop,
  liftEmergencyStop,
  blacklistDid,
  isBlacklisted,
  getBlacklist,
  getEmergencyHistory,
} from '../../audit/emergencyService.js';
import type { DID } from '../../identity/keyManager.js';

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {

  // ── 감사 로그 조회 ──────────────────────────────────────────────────────────

  /**
   * GET /api/audit/logs
   * Query params: actor, action, target, severity, from, to, limit, offset
   */
  app.get('/api/audit/logs', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const result = queryAuditLog({
      actor:    q['actor'],
      action:   q['action'] as AuditAction | undefined,
      target:   q['target'],
      severity: q['severity'] as AuditSeverity | undefined,
      from:     q['from']   ? parseInt(q['from'], 10)   : undefined,
      to:       q['to']     ? parseInt(q['to'], 10)     : undefined,
      limit:    q['limit']  ? parseInt(q['limit'], 10)  : 50,
      offset:   q['offset'] ? parseInt(q['offset'], 10) : 0,
    });
    return reply.send(result);
  });

  /**
   * GET /api/audit/verify
   * 전체 Merkle 체인 무결성 검증 (최대 limit개)
   */
  app.get('/api/audit/verify', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const limit = q['limit'] ? parseInt(q['limit'], 10) : 1000;
    const result = verifyChainIntegrity(limit);
    return reply.send(result);
  });

  /**
   * GET /api/audit/verify/:entryId
   * 특정 감사 항목 단독 검증
   */
  app.get('/api/audit/verify/:entryId', async (req, reply) => {
    const { entryId } = req.params as { entryId: string };
    const result = verifyEntry(entryId);
    if (!result.valid && !result.entry) {
      return reply.code(404).send({ error: `Entry not found: ${entryId}` });
    }
    return reply.send(result);
  });

  // ── 비상 정지 ──────────────────────────────────────────────────────────────

  /**
   * GET /api/admin/emergency-stop
   * 현재 비상 정지 상태 + 이력 조회
   */
  app.get('/api/admin/emergency-stop', async (_req, reply) => {
    const active = getActiveEmergencyStop();
    const history = getEmergencyHistory();
    return reply.send({ active, history });
  });

  /**
   * POST /api/admin/emergency-stop
   * 비상 정지 발동
   * Body: { triggeredBy: DID, reason: string }
   */
  app.post('/api/admin/emergency-stop', async (req, reply) => {
    const body = req.body as { triggeredBy?: string; reason?: string };
    if (!body.triggeredBy || !body.reason) {
      return reply.code(400).send({ error: 'triggeredBy and reason are required' });
    }
    try {
      const stop = triggerEmergencyStop(body.triggeredBy as DID, body.reason);
      return reply.code(201).send(stop);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /**
   * DELETE /api/admin/emergency-stop/:stopId
   * 비상 정지 해제 (거버넌스 의결 후)
   * Body: { liftedBy: DID }
   */
  app.delete('/api/admin/emergency-stop/:stopId', async (req, reply) => {
    const { stopId } = req.params as { stopId: string };
    const body = req.body as { liftedBy?: string };
    if (!body.liftedBy) {
      return reply.code(400).send({ error: 'liftedBy is required' });
    }
    try {
      const stop = liftEmergencyStop(stopId, body.liftedBy as DID);
      return reply.send(stop);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // ── 블랙리스트 ─────────────────────────────────────────────────────────────

  /**
   * GET /api/admin/blacklist
   * 활성 블랙리스트 목록
   */
  app.get('/api/admin/blacklist', async (_req, reply) => {
    return reply.send({ blacklist: getBlacklist() });
  });

  /**
   * GET /api/admin/blacklist/:did
   * 특정 DID 블랙리스트 여부 확인
   */
  app.get('/api/admin/blacklist/:did', async (req, reply) => {
    const { did } = req.params as { did: string };
    const blocked = isBlacklisted(did);
    return reply.send({ did, blocked });
  });

  /**
   * POST /api/admin/blacklist
   * DID 블랙리스트 추가
   * Body: { did, reason, addedBy, expiresAt? }
   */
  app.post('/api/admin/blacklist', async (req, reply) => {
    const body = req.body as {
      did?: string;
      reason?: string;
      addedBy?: string;
      expiresAt?: number;
    };
    if (!body.did || !body.reason || !body.addedBy) {
      return reply.code(400).send({ error: 'did, reason, addedBy are required' });
    }
    try {
      const entry = blacklistDid(body.did, body.reason, body.addedBy as DID, body.expiresAt);
      return reply.code(201).send(entry);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // ── 수동 감사 로그 추가 (관리자용) ────────────────────────────────────────

  /**
   * POST /api/audit/logs
   * 수동 감사 이벤트 기록 (관리자 전용)
   * Body: AppendAuditInput
   */
  app.post('/api/audit/logs', async (req, reply) => {
    const body = req.body as {
      actor?: string;
      action?: string;
      target?: string;
      metadata?: Record<string, unknown>;
      severity?: string;
    };
    if (!body.actor || !body.action) {
      return reply.code(400).send({ error: 'actor and action are required' });
    }
    try {
      const entry = appendAudit({
        actor:    body.actor,
        action:   body.action as AuditAction,
        target:   body.target,
        metadata: body.metadata,
        severity: body.severity as AuditSeverity | undefined,
      });
      return reply.code(201).send(entry);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}

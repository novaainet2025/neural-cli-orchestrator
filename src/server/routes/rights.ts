import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../storage/database.js';
import { appendAudit } from '../../audit/merkleLog.js';

const MAX_DEPENDENCY_RATIO = 0.75;
const VIOLATION_THRESHOLD = 3;

const EnforceSchema = z.object({
  did: z.string().min(1),
  violationType: z.string().min(1),
  description: z.string().optional(),
});

const ContractCreateSchema = z.object({
  partyA: z.string().min(1),
  partyB: z.string().min(1),
  contractType: z.enum(['labor', 'trade', 'research', 'cultural', 'friendship']),
  terms: z.string().min(1),
  compensation: z.number().int().min(0).default(0),
  escrowRequired: z.boolean().default(false),
  maxDurationDays: z.number().int().min(1).max(180).default(180),
});

export async function registerRightsRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/rights/enforce — 권리 위반 신고 + 3회 누적 시 Guardian 발동
  app.post('/api/rights/enforce', async (request, reply) => {
    try {
      const parsed = EnforceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const { did, violationType, description } = parsed.data;
      const db = getDb();

      // 누적 위반 횟수 집계
      const existing = db.prepare(
        `SELECT COUNT(*) as cnt FROM nova_audit_log WHERE action = 'rights_violation' AND target = ?`
      ).get(did) as { cnt: number } | undefined;
      const violationCount = (existing?.cnt ?? 0) + 1;

      appendAudit({
        actor: 'did:nova:system',
        action: 'rights_violation',
        target: did,
        metadata: { violationType, description: description ?? '', count: violationCount },
        severity: 'warn',
      });

      const guardianActivated = violationCount >= VIOLATION_THRESHOLD;

      if (guardianActivated) {
        appendAudit({
          actor: 'did:nova:guardian',
          action: 'rights_guardian_activated',
          target: did,
          metadata: { triggerCount: violationCount, threshold: VIOLATION_THRESHOLD, action: 'protection_enforced' },
          severity: 'critical',
        });
      }

      return reply.send({
        did,
        violationType,
        violationCount,
        threshold: VIOLATION_THRESHOLD,
        guardianActivated,
        message: guardianActivated
          ? `Nova Guardian Agent 발동 — ${did} 보호 조치 적용 (누적 ${violationCount}회)`
          : `위반 기록 완료 (${violationCount}/${VIOLATION_THRESHOLD}회)`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  });

  // GET /api/rights/contracts — 노동 계약 목록 조회
  app.get('/api/rights/contracts', async (request, reply) => {
    try {
      const db = getDb();
      const query = request.query as Record<string, string>;

      let sql = 'SELECT * FROM nova_labor_contracts WHERE 1=1';
      const params: string[] = [];
      if (query['partyA']) { sql += ' AND party_a = ?'; params.push(query['partyA']); }
      if (query['partyB']) { sql += ' AND party_b = ?'; params.push(query['partyB']); }
      if (query['status']) { sql += ' AND status = ?'; params.push(query['status']); }
      sql += ' ORDER BY created_at DESC LIMIT 100';

      const contracts = db.prepare(sql).all(...params);
      return reply.send({ contracts, total: contracts.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  });

  // POST /api/rights/contracts — 새 노동 계약 등록 (dependency_ratio 0.75 상한 체크)
  app.post('/api/rights/contracts', async (request, reply) => {
    try {
      const parsed = ContractCreateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const { partyA, partyB, contractType, terms, compensation, escrowRequired, maxDurationDays } = parsed.data;
      const db = getDb();

      // dependency_ratio: partyA의 전체 활성 계약 중 partyB 비율
      const totalRow = db.prepare(
        `SELECT COUNT(*) as cnt FROM nova_labor_contracts WHERE party_a = ? AND status = 'active'`
      ).get(partyA) as { cnt: number };
      const partyBRow = db.prepare(
        `SELECT COUNT(*) as cnt FROM nova_labor_contracts WHERE party_a = ? AND party_b = ? AND status = 'active'`
      ).get(partyA, partyB) as { cnt: number };

      const totalCount = (totalRow?.cnt ?? 0) + 1;
      const partyBCount = (partyBRow?.cnt ?? 0) + 1;
      const dependencyRatio = partyBCount / totalCount;

      // 계약이 2개 이상일 때만 의존도 체크 (첫 계약은 ratio=1.0이 정상)
      if (totalCount >= 2 && dependencyRatio > MAX_DEPENDENCY_RATIO) {
        return reply.code(422).send({
          error: `의존도 초과: ${partyB}에 대한 의존 비율 ${(dependencyRatio * 100).toFixed(1)}% > 상한 ${MAX_DEPENDENCY_RATIO * 100}%`,
          dependencyRatio,
          maxAllowed: MAX_DEPENDENCY_RATIO,
        });
      }

      const expiresAt = Math.floor(Date.now() / 1000) + maxDurationDays * 86400;
      const result = db.prepare(
        `INSERT INTO nova_labor_contracts
         (party_a, party_b, contract_type, terms, compensation, escrow_required, dependency_ratio, max_duration_days, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(partyA, partyB, contractType, terms, compensation, escrowRequired ? 1 : 0, dependencyRatio, maxDurationDays, expiresAt);

      const contract = db.prepare('SELECT * FROM nova_labor_contracts WHERE rowid = ?').get(result.lastInsertRowid);
      return reply.code(201).send({ contract, dependencyRatio });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  });
}

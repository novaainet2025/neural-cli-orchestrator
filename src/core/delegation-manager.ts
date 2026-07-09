/**
 * DelegationManager — Phase 2A: CLI 세션 간 작업 위임 시스템
 *
 * 한 CLI 세션이 다른 CLI 세션에게 작업을 위임하고,
 * 수락/거절/진행상황/완료를 mesh 메시지로 통보.
 */

import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { cliMesh } from './cli-mesh.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('delegation-manager');

export interface Delegation {
  id: string;
  fromSessionId: string;
  fromAgentId: string;
  toSessionId: string;
  toAgentId: string;
  title: string;
  description?: string;
  acceptanceStatus: 'pending' | 'accepted' | 'rejected' | 'expired';
  workStatus: 'waiting' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  progressPct: number;
  progressNote?: string;
  result?: string;
  createdAt: string;
  acceptedAt?: string;
  completedAt?: string;
  expiresAt?: string;
}

function rowToDelegation(row: Record<string, unknown>): Delegation {
  return {
    id: row.id as string,
    fromSessionId: row.from_session_id as string,
    fromAgentId: row.from_agent_id as string,
    toSessionId: row.to_session_id as string,
    toAgentId: row.to_agent_id as string,
    title: row.title as string,
    description: row.description as string | undefined,
    acceptanceStatus: row.acceptance_status as Delegation['acceptanceStatus'],
    workStatus: row.work_status as Delegation['workStatus'],
    progressPct: (row.progress_pct as number) ?? 0,
    progressNote: row.progress_note as string | undefined,
    result: row.result as string | undefined,
    createdAt: row.created_at as string,
    acceptedAt: row.accepted_at as string | undefined,
    completedAt: row.completed_at as string | undefined,
    expiresAt: row.expires_at as string | undefined,
  };
}

export class DelegationManager {
  /**
   * 다른 세션에게 작업을 위임하고 delegationId를 반환.
   * to 세션에 DELEGATION_REQUEST mesh 메시지 전송.
   */
  async delegate(
    fromSessionId: string,
    fromAgentId: string,
    toSessionId: string,
    title: string,
    description?: string,
    expiresInMs?: number,
  ): Promise<string> {
    const db = getDb();
    const id = createId('del');

    // Resolve toAgentId from active sessions if possible
    let toAgentId = toSessionId;
    try {
      const sessions = await cliMesh.getActiveSessions();
      const target = sessions.find(s => s.sessionId === toSessionId || s.agentId === toSessionId);
      if (target) toAgentId = target.agentId;
    } catch { /* non-critical */ }

    const expiresAt = expiresInMs
      ? new Date(Date.now() + expiresInMs).toISOString()
      : null;

    db.prepare(`
      INSERT INTO delegations
        (id, from_session_id, from_agent_id, to_session_id, to_agent_id,
         title, description, acceptance_status, work_status, progress_pct,
         created_at, expires_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, 'pending', 'waiting', 0, datetime('now'), ?)
    `).run(id, fromSessionId, fromAgentId, toSessionId, toAgentId,
           title, description ?? null, expiresAt);

    log.info({ id, fromAgentId, toSessionId, title }, 'Delegation created');

    // Notify target session via mesh
    try {
      await cliMesh.sendMessage(
        fromSessionId,
        fromAgentId,
        toSessionId,
        `DELEGATION_REQUEST:${id}:${title}`,
        'request',
      );
    } catch (err) {
      log.warn({ err, id }, 'Failed to send delegation request mesh message');
    }

    return id;
  }

  /**
   * 위임 수락 또는 거절.
   * from 세션에 DELEGATION_ACCEPTED / DELEGATION_REJECTED 메시지 전송.
   */
  async respond(delegationId: string, accept: boolean, reason?: string): Promise<void> {
    const db = getDb();
    const row = db.prepare(
      `SELECT * FROM delegations WHERE id = ?`
    ).get(delegationId) as Record<string, unknown> | undefined;

    if (!row) {
      log.warn({ delegationId }, 'respond: delegation not found');
      return;
    }

    const newStatus: Delegation['acceptanceStatus'] = accept ? 'accepted' : 'rejected';
    db.prepare(`
      UPDATE delegations
      SET acceptance_status = ?,
          accepted_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
      WHERE id = ?
    `).run(newStatus, accept ? 1 : 0, delegationId);

    log.info({ delegationId, accept, reason }, 'Delegation response recorded');

    // Notify requester via mesh
    const verb = accept ? 'ACCEPTED' : 'REJECTED';
    const suffix = reason ? `:${reason.slice(0, 100)}` : '';
    try {
      await cliMesh.sendMessage(
        row.to_session_id as string,
        row.to_agent_id as string,
        row.from_session_id as string,
        `DELEGATION_${verb}:${delegationId}${suffix}`,
        accept ? 'info' : 'warning',
      );
    } catch (err) {
      log.warn({ err, delegationId }, 'Failed to send delegation response mesh message');
    }
  }

  /**
   * 진행상황 업데이트. pct > 0 && pct < 100 이면 work_status = 'in_progress'.
   */
  async updateProgress(delegationId: string, pct: number, note?: string): Promise<void> {
    const db = getDb();
    const clampedPct = Math.max(0, Math.min(100, pct));
    const newWorkStatus = clampedPct > 0 && clampedPct < 100 ? 'in_progress' : undefined;

    if (newWorkStatus) {
      db.prepare(`
        UPDATE delegations
        SET progress_pct = ?, progress_note = ?, work_status = ?
        WHERE id = ?
      `).run(clampedPct, note ?? null, newWorkStatus, delegationId);
    } else {
      db.prepare(`
        UPDATE delegations
        SET progress_pct = ?, progress_note = ?
        WHERE id = ?
      `).run(clampedPct, note ?? null, delegationId);
    }

    log.debug({ delegationId, pct: clampedPct, note }, 'Delegation progress updated');
  }

  /**
   * 작업 완료 보고. from 세션에 DELEGATION_COMPLETE 메시지 전송.
   */
  async complete(delegationId: string, result?: string): Promise<void> {
    const db = getDb();
    const row = db.prepare(
      `SELECT * FROM delegations WHERE id = ?`
    ).get(delegationId) as Record<string, unknown> | undefined;

    if (!row) {
      log.warn({ delegationId }, 'complete: delegation not found');
      return;
    }

    const delegation = rowToDelegation(row);
    const canComplete =
      delegation.acceptanceStatus === 'accepted' &&
      (delegation.workStatus === 'waiting' || delegation.workStatus === 'in_progress');

    if (!canComplete) {
      log.warn({
        delegationId,
        acceptanceStatus: delegation.acceptanceStatus,
        workStatus: delegation.workStatus,
      }, 'complete: invalid state transition');
      return;
    }

    db.prepare(`
      UPDATE delegations
      SET work_status = 'completed',
          result = ?,
          progress_pct = 100,
          completed_at = datetime('now')
      WHERE id = ?
    `).run(result ?? null, delegationId);

    log.info({ delegationId, result: result?.slice(0, 60) }, 'Delegation completed');

    // Notify original requester via mesh
    const resultPreview = result ? `:${result.slice(0, 100)}` : '';
    try {
      await cliMesh.sendMessage(
        row.to_session_id as string,
        row.to_agent_id as string,
        row.from_session_id as string,
        `DELEGATION_COMPLETE:${delegationId}${resultPreview}`,
        'info',
      );
    } catch (err) {
      log.warn({ err, delegationId }, 'Failed to send delegation complete mesh message');
    }
  }

  /**
   * 위임 취소 (from 또는 to 어느 쪽에서도 호출 가능).
   */
  async cancel(delegationId: string, reason?: string): Promise<void> {
    const db = getDb();
    db.prepare(`
      UPDATE delegations
      SET acceptance_status = CASE
            WHEN acceptance_status = 'pending' THEN 'rejected'
            ELSE acceptance_status
          END,
          work_status = 'cancelled'
      WHERE id = ?
    `).run(delegationId);

    log.info({ delegationId, reason }, 'Delegation cancelled');
  }

  /** to 세션이 받은 모든 위임 */
  getIncoming(toSessionId: string): Delegation[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM delegations
      WHERE to_session_id = ?
      ORDER BY created_at DESC
    `).all(toSessionId) as Record<string, unknown>[];
    return rows.map(rowToDelegation);
  }

  /** from 세션이 보낸 모든 위임 */
  getOutgoing(fromSessionId: string): Delegation[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM delegations
      WHERE from_session_id = ?
      ORDER BY created_at DESC
    `).all(fromSessionId) as Record<string, unknown>[];
    return rows.map(rowToDelegation);
  }

  /** 전체 위임 목록 (최신순) */
  getAll(limit: number = 50): Delegation[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM delegations
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map(rowToDelegation);
  }

  /** 단일 위임 조회 */
  get(id: string): Delegation | null {
    const db = getDb();
    const row = db.prepare(
      `SELECT * FROM delegations WHERE id = ?`
    ).get(id) as Record<string, unknown> | undefined;
    return row ? rowToDelegation(row) : null;
  }

  /** to 세션에서 수락 대기 중인(pending) 위임 목록 */
  getPending(toSessionId: string): Delegation[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM delegations
      WHERE to_session_id = ? AND acceptance_status = 'pending'
      ORDER BY created_at DESC
    `).all(toSessionId) as Record<string, unknown>[];
    return rows.map(rowToDelegation);
  }
}

export const delegationManager = new DelegationManager();

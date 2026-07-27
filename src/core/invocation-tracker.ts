/**
 * InvocationTracker — Phase 1: 에이전트 호출 추적 + 완료 보고
 *
 * 어떤 CLI 세션이 어떤 에이전트를 호출했는지 기록하고,
 * 작업 완료 시 호출자 세션에 mesh 메시지로 자동 통보.
 */

import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { cliMesh } from './cli-mesh.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('invocation-tracker');

const LOOP_BLOCK_RETRY_DISABLED = new Set(['0', 'false', 'off']);

/**
 * 가드에 막힌 완료 알림을 notified=0으로 되돌릴지 여부.
 * 기본 on. `NCO_MESH_NOTIFY_LOOPBLOCK_RETRY=off`이면 종전 동작(notified=1)으로 즉시 복귀한다.
 */
export function isLoopBlockRetryEnabled(
  toggle: string | undefined = process.env.NCO_MESH_NOTIFY_LOOPBLOCK_RETRY,
): boolean {
  return !LOOP_BLOCK_RETRY_DISABLED.has(toggle?.trim().toLowerCase() ?? '');
}

export interface Invocation {
  id: string;
  callerSessionId: string;
  callerAgentId: string;
  targetAgentId: string;
  targetTaskId?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  prompt?: string;
  resultSummary?: string;
  error?: string;
  mode: string;
  durationMs?: number;
  createdAt: string;
  completedAt?: string;
  notified: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  model?: string;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  model?: string;
}

export interface InvocationOverview {
  active: Invocation[];
  recentCompleted: Invocation[];
}

function rowToInvocation(row: Record<string, unknown>): Invocation {
  return {
    id: row.id as string,
    callerSessionId: row.caller_session_id as string,
    callerAgentId: row.caller_agent_id as string,
    targetAgentId: row.target_agent_id as string,
    targetTaskId: row.target_task_id as string | undefined,
    status: row.status as Invocation['status'],
    prompt: row.prompt as string | undefined,
    resultSummary: row.result_summary as string | undefined,
    error: row.error as string | undefined,
    mode: row.mode as string,
    durationMs: row.duration_ms as number | undefined,
    createdAt: row.created_at as string,
    completedAt: row.completed_at as string | undefined,
    notified: Boolean(row.notified),
    promptTokens: (row.prompt_tokens as number | undefined) ?? undefined,
    completionTokens: (row.completion_tokens as number | undefined) ?? undefined,
    totalTokens: (row.total_tokens as number | undefined) ?? undefined,
    model: (row.model as string | undefined) ?? undefined,
  };
}

class InvocationTracker {
  /**
   * 새 호출을 DB에 기록하고 invocationId를 반환.
   */
  async recordInvocation(
    callerSessionId: string,
    callerAgentId: string,
    targetAgentId: string,
    prompt: string,
    mode: string = 'task',
    taskId?: string,
  ): Promise<string> {
    const db = getDb();
    const id = createId('inv');
    db.prepare(`
      INSERT INTO agent_invocations
        (id, caller_session_id, caller_agent_id, target_agent_id, target_task_id,
         status, prompt, mode, created_at, notified)
      VALUES
        (?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'), 0)
    `).run(id, callerSessionId, callerAgentId, targetAgentId, taskId ?? null, prompt, mode);

    log.debug(`Recorded invocation ${id}: ${callerAgentId} → ${targetAgentId} [${mode}]`);
    return id;
  }

  /**
   * 호출 상태를 'running'으로 업데이트.
   */
  startInvocation(invocationId: string): void {
    const db = getDb();
    db.prepare(`
      UPDATE agent_invocations SET status = 'running' WHERE id = ?
    `).run(invocationId);
    log.debug(`Started invocation ${invocationId}`);
  }

  /**
   * 완료 결과 기록 (completed / failed / cancelled).
   */
  completeInvocation(
    invocationId: string,
    status: 'completed' | 'failed' | 'cancelled',
    resultSummary?: string,
    error?: string,
    usage?: TokenUsage,
  ): void {
    const db = getDb();

    const row = db.prepare(
      `SELECT created_at FROM agent_invocations WHERE id = ?`
    ).get(invocationId) as { created_at: string } | undefined;

    let durationMs: number | null = null;
    if (row?.created_at) {
      // created_at은 SQLite datetime('now') = UTC이지만 타임존 표기가 없어
      // new Date()가 로컬로 파싱, KST에서 duration이 +9h 오염됨 (실측 9h+40s).
      // 'T'+'Z'를 붙여 UTC로 명시 파싱한다. 이미 ISO/타임존 표기가 있으면 그대로 둔다.
      const iso = /[TZ]|[+-]\d{2}:\d{2}$/.test(row.created_at)
        ? row.created_at
        : row.created_at.replace(' ', 'T') + 'Z';
      durationMs = Date.now() - new Date(iso).getTime();
    }

    const pT = usage?.promptTokens ?? 0;
    const cT = usage?.completionTokens ?? 0;
    const tT = usage?.totalTokens ?? (pT + cT);

    db.prepare(`
      UPDATE agent_invocations
      SET status = ?,
          result_summary = ?,
          error = ?,
          duration_ms = ?,
          completed_at = datetime('now'),
          prompt_tokens = ?,
          completion_tokens = ?,
          total_tokens = ?,
          model = COALESCE(?, model)
      WHERE id = ?
    `).run(
      status,
      resultSummary ?? null,
      error ?? null,
      durationMs,
      pT,
      cT,
      tT,
      usage?.model ?? null,
      invocationId,
    );

    log.debug(`Completed invocation ${invocationId} → ${status} (tokens=${tT})`);
  }

  /**
   * 호출자 세션에 완료 mesh 메시지를 전송하고 notified=1 업데이트.
   */
  async notifyCompletion(invocationId: string): Promise<void> {
    const db = getDb();
    const row = db.prepare(
      `SELECT * FROM agent_invocations WHERE id = ?`
    ).get(invocationId) as Record<string, unknown> | undefined;

    if (!row) {
      log.warn(`notifyCompletion: invocation ${invocationId} not found`);
      return;
    }

    const inv = rowToInvocation(row);
    if (inv.notified) {
      log.debug(`Invocation ${invocationId} already notified`);
      return;
    }

    const claimed = db.prepare(
      `UPDATE agent_invocations SET notified = 2 WHERE id = ? AND notified = 0`
    ).run(invocationId);
    if (claimed.changes === 0) {
      log.debug(`Invocation ${invocationId} notification already claimed`);
      return;
    }

    const statusIcon = inv.status === 'completed' ? '✅' : inv.status === 'failed' ? '❌' : '⊘';
    const summary = inv.resultSummary ? ` — ${inv.resultSummary.slice(0, 120)}` : '';
    const durationStr = inv.durationMs != null ? ` (${(inv.durationMs / 1000).toFixed(1)}s)` : '';
    const task = inv.targetTaskId
      ? db.prepare('SELECT assigned_to, metadata_json FROM tasks WHERE id = ?').get(inv.targetTaskId) as {
          assigned_to: string | null;
          metadata_json: string | null;
        } | undefined
      : undefined;
    let requestedProvider = inv.targetAgentId;
    if (task?.metadata_json) {
      try {
        const metadata = JSON.parse(task.metadata_json) as Record<string, unknown>;
        if (typeof metadata.requestedProvider === 'string') requestedProvider = metadata.requestedProvider;
      } catch { /* Preserve the invocation target when task metadata is malformed. */ }
    }
    const actualProvider = task?.assigned_to ?? inv.targetAgentId;
    const providerMismatch = requestedProvider !== actualProvider;
    const content =
      `${statusIcon} [${inv.mode}] ${actualProvider} 완료${providerMismatch ? ` (${requestedProvider} 요청→${actualProvider} 대행)` : ''}${durationStr}${summary}`;

    try {
      const receipt = await cliMesh.sendMessageWithReceipt(
        'nco-system',           // fromSessionId (system sender)
        'nco',                  // fromAgent
        inv.callerSessionId,    // toSessionId
        content,
        'info',
      );

      // cycle3 중복에러방지팀: collaboration-msg-loop 가드가 이 알림을 막으면
      // sendMessage는 예외 없이 queuedRecipients=0을 반환하므로, 아래 catch가 실행되지
      // 않아 전송되지 않은 메시지가 notified=1('전달됨')로 기록됐다 — 조용한 mesh 메시지 누락.
      // 가드 차단은 cooldownMs(기본 60s) 뒤 해소되는 일시적 상태이므로 notified=0(미전송)으로
      // 되돌려 상태를 사실대로 남긴다. mesh_unavailable/recipient_unavailable은 재시도해도
      // 즉시 해소되지 않고 무한 누적 위험이 있어 기존 동작(notified=1)을 유지한다.
      // 롤백: NCO_MESH_NOTIFY_LOOPBLOCK_RETRY=off (재빌드 불필요).
      if (isLoopBlockRetryEnabled() && receipt.reason === 'collaboration_loop_blocked') {
        db.prepare(
          `UPDATE agent_invocations SET notified = 0 WHERE id = ? AND notified = 2`
        ).run(invocationId);
        log.warn(
          `Completion notice for invocation ${invocationId} was blocked by the collaboration-msg-loop guard ` +
          `(channel nco-system->${inv.callerSessionId}); left unnotified instead of marking delivered`,
        );
        return;
      }

      db.prepare(
        `UPDATE agent_invocations SET notified = 1 WHERE id = ?`
      ).run(invocationId);
      log.debug(`Notified caller session ${inv.callerSessionId} for invocation ${invocationId}`);
    } catch (err) {
      db.prepare(
        `UPDATE agent_invocations SET notified = 0 WHERE id = ? AND notified = 2`
      ).run(invocationId);
      log.warn(`Failed to notify caller for invocation ${invocationId}: ${err}`);
    }
  }

  /**
   * 활성(pending/running) 호출 목록 반환.
   * sessionId 지정 시 해당 세션의 호출만 반환.
   */
  getActiveInvocations(sessionId?: string): Invocation[] {
    const db = getDb();
    const rows = sessionId
      ? db.prepare(`
          SELECT * FROM agent_invocations
          WHERE caller_session_id = ? AND status IN ('pending', 'running')
          ORDER BY created_at DESC
        `).all(sessionId)
      : db.prepare(`
          SELECT * FROM agent_invocations
          WHERE status IN ('pending', 'running')
          ORDER BY created_at DESC
        `).all();

    return (rows as Record<string, unknown>[]).map(rowToInvocation);
  }

  /**
   * 대시보드용 개요: 활성 호출 + 최근 완료 호출.
   */
  getOverview(): InvocationOverview {
    const db = getDb();

    const activeRows = db.prepare(`
      SELECT * FROM agent_invocations
      WHERE status IN ('pending', 'running')
      ORDER BY created_at DESC
      LIMIT 50
    `).all() as Record<string, unknown>[];

    const recentRows = db.prepare(`
      SELECT * FROM agent_invocations
      WHERE status IN ('completed', 'failed', 'cancelled')
      ORDER BY completed_at DESC
      LIMIT 20
    `).all() as Record<string, unknown>[];

    // 대시보드 목록 표시용 — 저장은 2000자지만 개요 페이로드는 500자로 자른다
    // (전문은 getInvocation() 단건 조회 또는 tasks.response에서)
    const forDisplay = (inv: Invocation): Invocation =>
      inv.resultSummary && inv.resultSummary.length > 500
        ? { ...inv, resultSummary: inv.resultSummary.slice(0, 500) + '…' }
        : inv;

    return {
      active: activeRows.map(rowToInvocation).map(forDisplay),
      recentCompleted: recentRows.map(rowToInvocation).map(forDisplay),
    };
  }

  /**
   * 특정 invocationId로 단일 호출 조회.
   */
  getInvocation(invocationId: string): Invocation | undefined {
    const db = getDb();
    const row = db.prepare(
      `SELECT * FROM agent_invocations WHERE id = ?`
    ).get(invocationId) as Record<string, unknown> | undefined;
    return row ? rowToInvocation(row) : undefined;
  }

  /**
   * 페이지네이션 지원 전체 이력 조회.
   */
  listInvocations(limit: number = 20, offset: number = 0): Invocation[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM agent_invocations
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as Record<string, unknown>[];
    return rows.map(rowToInvocation);
  }
}

export const invocationTracker = new InvocationTracker();

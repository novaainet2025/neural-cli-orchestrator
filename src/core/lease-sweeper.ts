import { getDb } from '../storage/database.js';
import { TERMINAL_STATES, transitionTask } from './task-state.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('lease-sweeper');

export const LEASE_DURATION_MS = 90_000;
export const LEASE_SWEEP_INTERVAL_MS = 30_000;
/** assigned 상태인데 worker가 lease를 한 번도 발급하지 않은 채 머물 수 있는 상한. */
export const UNCLAIMED_TASK_TIMEOUT_MS = 10 * 60_000;
/** 한 tick의 failover 폭주가 다시 큐를 포화시키지 않도록 제한한다. */
export const LEASE_SWEEP_BATCH_LIMIT = 8;

export type LeaseSweepReason =
  | 'lease_expired'
  | 'claim_timeout'
  | 'lease_expired_twice'
  | 'claim_timeout_twice';

type ProgressPayload = {
  step: number;
  total: number;
};

type LeaseTaskRow = {
  id: string;
  status: string | null;
  progress: number | null;
  acked_at: string | null;
  last_heartbeat_at: string | null;
  heartbeat_seq: number | null;
  lease_expires_at: string | null;
};

type LeaseTouchResult =
  | { ok: true; task: LeaseTaskRow }
  | { ok: false; reason: 'not_found' | 'conflict'; status?: string | null };

type LeaseSweepMarkResult =
  | { kind: 'skip' }
  | { kind: 'lease_expired'; taskId: string; reason: 'lease_expired' | 'claim_timeout' }
  | {
      kind: 'failed_twice';
      taskId: string;
      reason: 'lease_expired_twice' | 'claim_timeout_twice';
    };

export function getTaskLeaseFields(taskId: string): LeaseTaskRow | undefined {
  return getDb().prepare(`
    SELECT id, status, progress, acked_at, last_heartbeat_at, heartbeat_seq, lease_expires_at
    FROM tasks
    WHERE id=?
  `).get(taskId) as LeaseTaskRow | undefined;
}

export function acknowledgeTaskLease(taskId: string): LeaseTouchResult {
  const db = getDb();
  const existing = getTaskLeaseFields(taskId);
  if (!existing) {
    return { ok: false, reason: 'not_found' };
  }
  if (existing.status !== 'assigned') {
    return { ok: false, reason: 'conflict', status: existing.status };
  }

  db.prepare(`
    UPDATE tasks
    SET acked_at = COALESCE(acked_at, datetime('now')),
        lease_expires_at = datetime('now', '+90 seconds'),
        updated_at = datetime('now')
    WHERE id = ?
      AND status = 'assigned'
  `).run(taskId);

  return { ok: true, task: getTaskLeaseFields(taskId)! };
}

export function recordTaskHeartbeat(
  taskId: string,
  options?: {
    progress?: ProgressPayload;
    note?: string;
  },
): LeaseTouchResult {
  const db = getDb();
  const existing = getTaskLeaseFields(taskId);
  if (!existing) {
    return { ok: false, reason: 'not_found' };
  }
  if (existing.status && (TERMINAL_STATES.has(existing.status) || existing.status === 'lease_expired')) {
    return { ok: false, reason: 'conflict', status: existing.status };
  }

  const progress = normalizeProgress(options?.progress);
  const metadataJson = appendHeartbeatNote(taskId, options?.note);
  const sets = [
    "last_heartbeat_at = datetime('now')",
    'heartbeat_seq = COALESCE(heartbeat_seq, 0) + 1',
    "lease_expires_at = datetime('now', '+90 seconds')",
    "updated_at = datetime('now')",
  ];
  const params: unknown[] = [];

  if (progress !== undefined) {
    sets.push('progress = ?');
    params.push(progress);
  }
  if (metadataJson !== undefined) {
    sets.push('metadata_json = ?');
    params.push(metadataJson);
  }

  db.prepare(`
    UPDATE tasks
    SET ${sets.join(', ')}
    WHERE id = ?
      AND status NOT IN ('completed', 'failed', 'timed_out', 'cancelled', 'lease_expired')
  `).run(...params, taskId);

  return { ok: true, task: getTaskLeaseFields(taskId)! };
}

export async function sweepExpiredTaskLeasesOnce(
  onLeaseExpired: (taskId: string, reason: LeaseSweepReason) => Promise<void>,
): Promise<void> {
  const expired = getDb().prepare(`
    SELECT id,
           CASE WHEN lease_expires_at IS NULL THEN 'claim_timeout' ELSE 'lease_expired' END AS reason
    FROM tasks
    WHERE (
        status IN ('assigned', 'running', 'streaming')
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= datetime('now')
      )
      OR (
        status = 'assigned'
        AND lease_expires_at IS NULL
        AND acked_at IS NULL
        AND COALESCE(last_activity_at, updated_at, created_at)
          <= datetime('now', '-${Math.floor(UNCLAIMED_TASK_TIMEOUT_MS / 1000)} seconds')
      )
    ORDER BY COALESCE(lease_expires_at, last_activity_at, updated_at, created_at) ASC, created_at ASC
    LIMIT ${LEASE_SWEEP_BATCH_LIMIT}
  `).all() as Array<{ id: string; reason: 'lease_expired' | 'claim_timeout' }>;

  for (const task of expired) {
    const marked = markTaskLeaseExpired(task.id, task.reason);
    if (marked.kind === 'lease_expired' || marked.kind === 'failed_twice') {
      await onLeaseExpired(marked.taskId, marked.reason);
    }
  }
}

export function startLeaseSweeper(options: {
  onLeaseExpired: (taskId: string, reason: LeaseSweepReason) => Promise<void>;
}): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepExpiredTaskLeasesOnce(options.onLeaseExpired);
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, 'Lease sweep failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, LEASE_SWEEP_INTERVAL_MS);
  timer.unref?.();

  return () => clearInterval(timer);
}

function normalizeProgress(progress?: ProgressPayload): number | undefined {
  if (!progress) return undefined;
  if (!Number.isFinite(progress.step) || !Number.isFinite(progress.total) || progress.total <= 0) {
    return undefined;
  }
  if (progress.step < 0) return 0;
  return Math.max(0, Math.min(progress.step / progress.total, 1));
}

function appendHeartbeatNote(taskId: string, note?: string): string | undefined {
  if (typeof note !== 'string') return undefined;
  const db = getDb();
  const row = db.prepare('SELECT metadata_json FROM tasks WHERE id=?').get(taskId) as { metadata_json: string | null } | undefined;
  let metadata: Record<string, unknown> = {};
  if (row?.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  metadata.lastHeartbeatNote = note;
  return JSON.stringify(metadata);
}

function markTaskLeaseExpired(
  taskId: string,
  reason: 'lease_expired' | 'claim_timeout',
): LeaseSweepMarkResult {
  const db = getDb();
  const tx = db.transaction((id: string): LeaseSweepMarkResult => {
    const task = db.prepare(`
      SELECT id, status, parent_task_id, assigned_to
      FROM tasks
      WHERE id = ?
    `).get(id) as {
      id: string;
      status: string;
      parent_task_id: string | null;
      assigned_to: string | null;
    } | undefined;
    if (!task || !['assigned', 'running', 'streaming'].includes(task.status)) {
      return { kind: 'skip' };
    }

    // 과거 retry 구현은 직전 attempt를 parent로 저장해 root→child→grandchild 계보를
    // 만들었다. 한 단계 parent만 보면 그 계보에서 두 번째 lease 만료가 첫 만료처럼
    // 취급되어 자동 대체 상한을 우회한다. 순환/손상 데이터에도 종료되는 재귀 root를 쓴다.
    const source = db.prepare(`
      WITH RECURSIVE ancestors(id, parent_task_id, depth, path) AS (
        SELECT id, parent_task_id, 0, ',' || id || ','
        FROM tasks
        WHERE id = ?
        UNION ALL
        SELECT parent.id, parent.parent_task_id, ancestors.depth + 1,
               ancestors.path || parent.id || ','
        FROM tasks AS parent
        JOIN ancestors ON parent.id = ancestors.parent_task_id
        WHERE ancestors.depth < 63
          AND instr(ancestors.path, ',' || parent.id || ',') = 0
      )
      SELECT id
      FROM ancestors
      ORDER BY depth DESC
      LIMIT 1
    `).get(task.id) as { id: string } | undefined;
    const sourceTaskId = source?.id ?? task.id;
    const previousExpirations = db.prepare(`
      WITH RECURSIVE lineage(id, depth, path) AS (
        SELECT id, 0, ',' || id || ','
        FROM tasks
        WHERE id = ?
        UNION ALL
        SELECT child.id, lineage.depth + 1, lineage.path || child.id || ','
        FROM tasks AS child
        JOIN lineage ON child.parent_task_id = lineage.id
        WHERE lineage.depth < 63
          AND instr(lineage.path, ',' || child.id || ',') = 0
      )
      SELECT COUNT(*) AS count
      FROM lineage
      JOIN tasks ON tasks.id = lineage.id
      WHERE tasks.status = 'lease_expired'
    `).get(sourceTaskId) as { count: number };

    if ((previousExpirations.count ?? 0) >= 1) {
      const moved = transitionTask(db, task.id, 'failed', {
        error: reason === 'claim_timeout' ? 'claim_timeout_twice' : 'lease_expired_twice',
        completedAt: true,
      });
      if (!moved.ok) {
        return { kind: 'skip' };
      }
      return {
        kind: 'failed_twice',
        taskId: task.id,
        reason: reason === 'claim_timeout' ? 'claim_timeout_twice' : 'lease_expired_twice',
      };
    }

    const moved = transitionTask(db, task.id, 'lease_expired', {
      error: reason,
      completedAt: true,
    });
    if (!moved.ok) {
      return { kind: 'skip' };
    }
    return { kind: 'lease_expired', taskId: task.id, reason };
  });

  return tx(taskId);
}

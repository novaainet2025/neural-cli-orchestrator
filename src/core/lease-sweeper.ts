import { getDb } from '../storage/database.js';
import { TERMINAL_STATES, transitionTask } from './task-state.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('lease-sweeper');

export const LEASE_DURATION_MS = 90_000;
export const LEASE_SWEEP_INTERVAL_MS = 30_000;

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
  | { kind: 'lease_expired'; taskId: string }
  | { kind: 'failed_twice'; taskId: string };

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
  onLeaseExpired: (taskId: string) => Promise<void>,
): Promise<void> {
  const expired = getDb().prepare(`
    SELECT id
    FROM tasks
    WHERE status = 'assigned'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= datetime('now')
    ORDER BY lease_expires_at ASC, created_at ASC
  `).all() as Array<{ id: string }>;

  for (const task of expired) {
    const marked = markTaskLeaseExpired(task.id);
    if (marked.kind === 'lease_expired') {
      await onLeaseExpired(marked.taskId);
    }
  }
}

export function startLeaseSweeper(options: {
  onLeaseExpired: (taskId: string) => Promise<void>;
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

function markTaskLeaseExpired(taskId: string): LeaseSweepMarkResult {
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
    if (!task || task.status !== 'assigned') {
      return { kind: 'skip' };
    }

    const sourceTaskId = task.parent_task_id ?? task.id;
    const previousExpirations = db.prepare(`
      SELECT COUNT(*) AS count
      FROM tasks
      WHERE (id = ? OR parent_task_id = ?)
        AND status = 'lease_expired'
    `).get(sourceTaskId, sourceTaskId) as { count: number };

    if ((previousExpirations.count ?? 0) >= 1) {
      const moved = transitionTask(db, task.id, 'failed', {
        error: 'lease_expired_twice',
        completedAt: true,
      });
      if (!moved.ok) {
        return { kind: 'skip' };
      }
      return { kind: 'failed_twice', taskId: task.id };
    }

    const moved = transitionTask(db, task.id, 'lease_expired', {
      error: 'lease_expired',
      completedAt: true,
    });
    if (!moved.ok) {
      return { kind: 'skip' };
    }
    return { kind: 'lease_expired', taskId: task.id };
  });

  return tx(taskId);
}

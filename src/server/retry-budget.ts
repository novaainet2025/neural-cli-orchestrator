import type Database from 'better-sqlite3';

export const RETRY_WINDOW_HOURS = 6;
export const RETRY_WINDOW_LIMIT = 3;
export const RETRY_LIFETIME_LIMIT = 10;

interface RetryCountRow {
  count: number;
  total_count: number;
  updated_at: string | null;
}

export const RETRY_LIFETIME_DEAD_LETTER_REASON = 'retry_lifetime_limit';

function deadLetterLifetimeExhaustion(
  db: Database.Database,
  sourceTaskId: string,
): void {
  db.prepare(`
    INSERT INTO dead_letter_tasks (task_id, ai, prompt, reason)
    SELECT id, assigned_to, prompt, ?
    FROM tasks
    WHERE id=?
      AND NOT EXISTS (
        SELECT 1
        FROM dead_letter_tasks
        WHERE task_id=? AND reason=?
      )
  `).run(
    RETRY_LIFETIME_DEAD_LETTER_REASON,
    sourceTaskId,
    sourceTaskId,
    RETRY_LIFETIME_DEAD_LETTER_REASON,
  );
}

function timestampMs(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

export function readRetryCount(db: Database.Database, taskId: string): RetryCountRow | undefined {
  return db.prepare(`
    SELECT count, total_count, updated_at
    FROM retry_counts
    WHERE task_id=?
  `).get(taskId) as RetryCountRow | undefined;
}

export function reserveRetry(
  db: Database.Database,
  taskId: string,
):
  | { allowed: true; count: number; totalCount: number }
  | { allowed: false; count: number; totalCount: number; reason: 'window_limit' | 'lifetime_limit' } {
  const reserve = db.transaction((sourceTaskId: string) => {
    const row = readRetryCount(db, sourceTaskId);
    const updatedAtMs = timestampMs(row?.updated_at);
    const windowExpired = !Number.isFinite(updatedAtMs)
      || updatedAtMs <= Date.now() - RETRY_WINDOW_HOURS * 60 * 60_000;
    const count = windowExpired ? 0 : (row?.count ?? 0);
    const totalCount = row?.total_count ?? row?.count ?? 0;
    if (totalCount >= RETRY_LIFETIME_LIMIT) {
      deadLetterLifetimeExhaustion(db, sourceTaskId);
      return { allowed: false as const, count, totalCount, reason: 'lifetime_limit' as const };
    }
    if (count >= RETRY_WINDOW_LIMIT) {
      return { allowed: false as const, count, totalCount, reason: 'window_limit' as const };
    }
    db.prepare(`
      INSERT INTO retry_counts (task_id, count, total_count, updated_at)
      VALUES (?, 1, 1, datetime('now'))
      ON CONFLICT(task_id) DO UPDATE SET
        count = CASE
          WHEN retry_counts.updated_at IS NULL
            OR retry_counts.updated_at <= datetime('now', '-${RETRY_WINDOW_HOURS} hours')
          THEN 1 ELSE retry_counts.count + 1 END,
        total_count = retry_counts.total_count + 1,
        updated_at = datetime('now')
    `).run(sourceTaskId);
    const updated = readRetryCount(db, sourceTaskId)!;
    return { allowed: true as const, count: updated.count, totalCount: updated.total_count };
  });
  return reserve.immediate(taskId);
}

export function rollbackRetryReservation(db: Database.Database, taskId: string): void {
  db.prepare(`
    UPDATE retry_counts
    SET count = MAX(count - 1, 0),
        total_count = MAX(total_count - 1, 0),
        updated_at = datetime('now')
    WHERE task_id=?
  `).run(taskId);
}

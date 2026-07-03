import type Database from 'better-sqlite3';

export const TERMINAL_STATES = new Set(['completed', 'failed', 'timed_out', 'cancelled']);

export const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  queued: new Set(['assigned', 'running', 'cancelled', 'failed']),
  assigned: new Set(['running', 'streaming', 'completed', 'failed', 'timed_out', 'cancelled']),
  running: new Set(['streaming', 'completed', 'failed', 'timed_out', 'cancelled']),
  streaming: new Set(['completed', 'failed', 'timed_out', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  timed_out: new Set(),
  cancelled: new Set(),
};

const ALLOWED_SOURCES_BY_TARGET = new Map<string, string[]>();

for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
  for (const target of targets) {
    const allowed = ALLOWED_SOURCES_BY_TARGET.get(target) ?? [];
    allowed.push(from);
    ALLOWED_SOURCES_BY_TARGET.set(target, allowed);
  }
}

export function transitionTask(
  db: Database.Database,
  taskId: string,
  next: string,
  extra?: { response?: string; error?: string; completedAt?: boolean; evidenceJson?: string },
): { ok: boolean; prev?: string } {
  const allowedSources = ALLOWED_SOURCES_BY_TARGET.get(next) ?? [];
  if (allowedSources.length === 0) {
    const current = db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status?: string } | undefined;
    return { ok: false, prev: current?.status };
  }

  const sets = ['status=?', "updated_at=datetime('now')"];
  const params: unknown[] = [next];

  if (extra?.response !== undefined) {
    sets.push('response=?');
    params.push(extra.response);
  }
  if (extra?.error !== undefined) {
    sets.push('error=?');
    params.push(extra.error);
  }
  if (extra?.completedAt) {
    sets.push("completed_at=datetime('now')");
  }
  if (extra?.evidenceJson !== undefined) {
    sets.push('evidence_json=?');
    params.push(extra.evidenceJson);
  }

  const placeholders = allowedSources.map(() => '?').join(', ');
  const sql = `
    UPDATE tasks
    SET ${sets.join(', ')}
    WHERE id = ?
      AND status IN (${placeholders})
  `;
  const result = db.prepare(sql).run(...params, taskId, ...allowedSources);

  if (result.changes === 1) {
    return { ok: true };
  }

  const current = db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status?: string } | undefined;
  return { ok: false, prev: current?.status };
}

import type Database from 'better-sqlite3';
import { refreshTeamCircuitFromRecentFailures } from '../security/team-circuit-guard.js';
import { recordWorkEventSafely } from './work-event-ledger.js';

export const TERMINAL_STATES = new Set(['completed', 'failed', 'timed_out', 'cancelled', 'lease_expired']);

const UNKNOWN_FAILURE_REASON = 'unknown: failure reason unavailable';

function parseEvidenceJson(value: string | undefined): unknown {
  if (value == null) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [{ invalidEvidenceJson: true, raw: value }];
  }
}

export const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  queued: new Set(['assigned', 'running', 'cancelled', 'failed']),
  assigned: new Set(['running', 'streaming', 'reviewing', 'completed', 'failed', 'timed_out', 'cancelled', 'lease_expired']),
  running: new Set(['streaming', 'reviewing', 'completed', 'failed', 'timed_out', 'cancelled']),
  streaming: new Set(['reviewing', 'completed', 'failed', 'timed_out', 'cancelled']),
  reviewing: new Set(['completed', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  timed_out: new Set(),
  cancelled: new Set(),
  lease_expired: new Set(),
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
  const prior = db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status?: string } | undefined;
  if (next === 'completed') {
    const auditRow = db.prepare(`
      SELECT team_id, metadata_json
      FROM tasks
      WHERE id=?
    `).get(taskId) as {
      team_id?: string | null;
      metadata_json?: string | null;
    } | undefined;
    if (auditRow?.team_id) {
      let metadata: Record<string, unknown> = {};
      try {
        metadata = auditRow.metadata_json
          ? JSON.parse(auditRow.metadata_json) as Record<string, unknown>
          : {};
      } catch {
        metadata = {};
      }
      const auditControlPlane = metadata.auditControlPlane === true
        || typeof metadata.verificationDirectiveId === 'string';
      const approved = metadata.verificationStatus === 'approved'
        && typeof metadata.verificationReceiptId === 'string'
        && metadata.verificationReceiptId.trim().length > 0;
      if (!auditControlPlane && !approved) {
        return { ok: false, prev: prior?.status };
      }
    }
  }
  const allowedSources = ALLOWED_SOURCES_BY_TARGET.get(next) ?? [];
  if (allowedSources.length === 0) {
    return { ok: false, prev: prior?.status };
  }

  const sets = ['status=?', "updated_at=datetime('now')"];
  const params: unknown[] = [next];
  const transitionError = next === 'failed' && !extra?.error?.trim()
    ? UNKNOWN_FAILURE_REASON
    : extra?.error;

  if (extra?.response !== undefined) {
    sets.push('response=?');
    params.push(extra.response);
  }
  if (transitionError !== undefined) {
    sets.push('error=?');
    params.push(transitionError);
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
    if (next === 'failed') {
      const teamRow = db.prepare('SELECT team_id FROM tasks WHERE id=?').get(taskId) as
        | { team_id?: string | null }
        | undefined;
      if (teamRow?.team_id) {
        try {
          refreshTeamCircuitFromRecentFailures(db, teamRow.team_id);
        } catch {
          // best-effort team circuit refresh must not block task transitions
        }
      }
    }
    recordWorkEventSafely({
      source: 'task-state',
      eventType: `task:${next}`,
      eventKey: `task-state:${taskId}:${prior?.status ?? 'unknown'}:${next}:${Date.now()}`,
      title: `Task ${taskId}: ${prior?.status ?? 'unknown'} → ${next}`,
      summary: transitionError ?? null,
      detail: {
        previousStatus: prior?.status ?? null,
        nextStatus: next,
        responseBytes: extra?.response == null ? 0 : Buffer.byteLength(extra.response),
        hasEvidence: extra?.evidenceJson != null,
        error: transitionError ?? null,
      },
      evidence: parseEvidenceJson(extra?.evidenceJson),
      taskId,
      occurredAt: Date.now(),
    }, db);
    if (next === 'completed') {
      const taskOutput = extra?.response || '';
      // Actually we are in ESM, so let's import dynamically
      Promise.resolve().then(async () => {
        try {
          const { extractTaskEvidenceJson } = await import('./task-evidence.js');
          const evidenceResult = extractTaskEvidenceJson(taskOutput);
          if (!evidenceResult.warning && evidenceResult.evidenceJson) {
            const parsed = JSON.parse(evidenceResult.evidenceJson);
            const hasT1orT2 = Array.isArray(parsed) && parsed.some((item: any) => item.tier === 'T1' || item.tier === 'T2');
            if (hasT1orT2) {
              const { gatherTaskTrajectory, skillDistiller } = await import('./skill-distiller.js');
              const trajectory = await gatherTaskTrajectory(taskId);
              if (trajectory.taskType !== 'distill') {
                const projectPath = process.env.PROJECT_DIR || './';
                await skillDistiller.runPipeline(taskId, taskOutput, projectPath, trajectory);
              }
            }
          }
        } catch (err) {
          // Ignore background processing errors to prevent breaking task completion flow
        }
      });
    }
    return { ok: true };
  }

  const current = db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status?: string } | undefined;
  return { ok: false, prev: current?.status };
}

import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('decision-log');

export interface LogDecisionInput {
  taskId?: string;
  phase?: string;
  decision: string;
  reason?: string;
  evidenceTier?: string;
  actor?: string;
}

export function logDecision(input: LogDecisionInput): void {
  try {
    getDb().prepare(`
      INSERT INTO decision_log (id, task_id, phase, decision, reason, evidence_tier, actor)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      createId('decision'),
      input.taskId ?? null,
      input.phase ?? null,
      input.decision,
      input.reason ?? null,
      input.evidenceTier ?? null,
      input.actor ?? 'system',
    );
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to log decision');
  }
}

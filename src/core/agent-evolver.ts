/**
 * AgentEvolver — lightweight prompt/persona auto-tuning (AgentEvolver-inspired).
 * Tracks per-agent success/failure rates and adjusts system prompt persona
 * suggestions based on empirical task performance.
 *
 * Storage: SQLite table `agent_evolution_log`
 * Exposed via: GET /api/evolver/:agentId/stats
 *              POST /api/evolver/:agentId/tune
 */
import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('agent-evolver');

export interface EvolutionStats {
  agentId: string;
  totalTasks: number;
  successRate: number;
  avgDurationMs: number;
  suggestedTone: string;
  suggestedFocus: string;
}

class AgentEvolver {
  private ensureTable(): void {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_evolution_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        success INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        output_length INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_evo_agent ON agent_evolution_log(agent_id);
    `);
  }

  /**
   * Record a task outcome for evolution tracking.
   */
  record(agentId: string, taskId: string, success: boolean, durationMs: number, outputLength = 0): void {
    try {
      this.ensureTable();
      const db = getDb();
      db.prepare(
        'INSERT INTO agent_evolution_log (agent_id, task_id, success, duration_ms, output_length) VALUES (?, ?, ?, ?, ?)'
      ).run(agentId, taskId, success ? 1 : 0, durationMs, outputLength);
    } catch (err: any) {
      log.debug({ err: err.message }, 'evolution record failed (non-critical)');
    }
  }

  /**
   * Compute evolution stats and derive persona suggestions.
   */
  getStats(agentId: string, windowSize = 50): EvolutionStats {
    this.ensureTable();
    const db = getDb();
    const rows = db
      .prepare(
        'SELECT success, duration_ms, output_length FROM agent_evolution_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?'
      )
      .all(agentId, windowSize) as { success: number; duration_ms: number; output_length: number }[];

    const totalTasks = rows.length;
    if (totalTasks === 0) {
      return { agentId, totalTasks: 0, successRate: 0, avgDurationMs: 0, suggestedTone: 'neutral', suggestedFocus: 'general' };
    }

    const successCount = rows.filter(r => r.success === 1).length;
    const successRate = successCount / totalTasks;
    const avgDurationMs = rows.reduce((a, r) => a + r.duration_ms, 0) / totalTasks;
    const avgOutput = rows.reduce((a, r) => a + r.output_length, 0) / totalTasks;

    // Simple heuristic-based persona suggestions
    let suggestedTone = 'neutral';
    let suggestedFocus = 'general';

    if (successRate < 0.5) {
      suggestedTone = 'careful';
      suggestedFocus = 'verification';
    } else if (successRate > 0.85 && avgDurationMs < 10_000) {
      suggestedTone = 'confident';
      suggestedFocus = 'speed';
    } else if (avgOutput < 100) {
      suggestedTone = 'detailed';
      suggestedFocus = 'thoroughness';
    } else {
      suggestedTone = 'balanced';
      suggestedFocus = 'quality';
    }

    return { agentId, totalTasks, successRate, avgDurationMs, suggestedTone, suggestedFocus };
  }

  /**
   * Generate a system prompt prefix suggestion based on evolution stats.
   */
  generatePromptHint(agentId: string): string {
    const stats = this.getStats(agentId);
    if (stats.totalTasks < 5) return ''; // not enough data

    const hints: Record<string, string> = {
      careful: 'Double-check your work before responding. Verify each step carefully.',
      confident: 'Be concise and direct. You have strong task success history.',
      detailed: 'Provide detailed, comprehensive responses with examples.',
      balanced: 'Balance thoroughness with efficiency in your responses.',
      neutral: '',
    };

    return hints[stats.suggestedTone] ?? '';
  }
}

export const agentEvolver = new AgentEvolver();

/**
 * SleepConsolidator — SCM-inspired asynchronous memory consolidation.
 *
 * Mimics NREM/REM sleep stages:
 *   NREM: Replay recent memories, boost importance of frequently accessed
 *   REM:  Prune low-importance stale memories, merge near-duplicates
 *
 * Runs as a background job (default: every 6 hours via CronScheduler).
 * Non-blocking — NCO continues operating during consolidation.
 */

import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';
import { vectorMemory } from './vector-memory.js';

const log = createLogger('sleep-consolidator');

export interface ConsolidationReport {
  agentId: string;
  boosted: number;    // memories whose importance was raised
  pruned: number;     // stale/duplicate memories removed
  total: number;      // remaining memories
  durationMs: number;
}

class SleepConsolidator {
  private running = false;

  /**
   * Run full consolidation for all agents (or a specific one).
   * NREM: Boost frequently accessed recent memories.
   * REM:  Prune stale + low-importance memories (keep top N per agent).
   */
  async consolidate(agentId?: string): Promise<ConsolidationReport[]> {
    if (this.running) {
      log.warn('Consolidation already in progress — skipped');
      return [];
    }
    this.running = true;
    const reports: ConsolidationReport[] = [];
    const start = Date.now();

    try {
      const db = getDb();
      const agents: string[] = agentId
        ? [agentId]
        : (db.prepare('SELECT DISTINCT agent_id FROM mem0_entries').all() as any[]).map(r => r.agent_id);

      for (const aid of agents) {
        const report = await this.consolidateAgent(aid);
        reports.push(report);
        log.info(report, 'Agent memory consolidated');
      }
    } finally {
      this.running = false;
      await vectorMemory.flushAll();
    }

    log.info({ agents: reports.length, totalMs: Date.now() - start }, 'Sleep consolidation complete');
    return reports;
  }

  private async consolidateAgent(agentId: string): Promise<ConsolidationReport> {
    const db = getDb();
    const start = Date.now();

    // ── NREM: Boost frequently accessed memories ──────────────────────────
    const boosted = db.prepare(`
      UPDATE mem0_entries
      SET importance = MIN(5.0, importance * (1 + 0.1 * access_count))
      WHERE agent_id = ?
        AND access_count > 2
        AND datetime(created_at) > datetime('now', '-30 days')
    `).run(agentId).changes;

    // ── REM: Decay importance of never-accessed old memories ──────────────
    db.prepare(`
      UPDATE mem0_entries
      SET importance = importance * 0.8
      WHERE agent_id = ?
        AND access_count = 0
        AND datetime(created_at) < datetime('now', '-7 days')
    `).run(agentId);

    // ── REM: Prune memories with importance < 0.1 (forgotten) ────────────
    const pruned = db.prepare(`
      DELETE FROM mem0_entries
      WHERE agent_id = ? AND importance < 0.1
    `).run(agentId).changes;

    // ── REM: Keep at most 10,000 memories per agent (oldest pruned) ───────
    const total = (db.prepare('SELECT COUNT(*) as n FROM mem0_entries WHERE agent_id = ?').get(agentId) as any).n;
    const MAX_PER_AGENT = 10_000;
    if (total > MAX_PER_AGENT) {
      const toDelete = total - MAX_PER_AGENT;
      db.prepare(`
        DELETE FROM mem0_entries WHERE id IN (
          SELECT id FROM mem0_entries WHERE agent_id = ?
          ORDER BY importance ASC, created_at ASC LIMIT ?
        )
      `).run(agentId, toDelete);
    }

    const finalCount = (db.prepare('SELECT COUNT(*) as n FROM mem0_entries WHERE agent_id = ?').get(agentId) as any).n;

    return {
      agentId,
      boosted,
      pruned,
      total: finalCount,
      durationMs: Date.now() - start,
    };
  }

  get isRunning() { return this.running; }
}

export const sleepConsolidator = new SleepConsolidator();

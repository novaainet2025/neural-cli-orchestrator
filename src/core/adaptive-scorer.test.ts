import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeOperationalReliabilityWeight } from './adaptive-scorer.js';

describe('computeOperationalReliabilityWeight', () => {
  it('rewards reliable low-latency providers', () => {
    const fastReliable = computeOperationalReliabilityWeight(0.96, 70_000);
    const slowLessReliable = computeOperationalReliabilityWeight(0.86, 130_000);
    expect(fastReliable).toBeGreaterThan(slowLessReliable);
  });

  it('bounds malformed telemetry safely', () => {
    expect(computeOperationalReliabilityWeight(4, 1)).toBeLessThanOrEqual(2);
    expect(computeOperationalReliabilityWeight(-3, 0)).toBeGreaterThanOrEqual(0.2);
  });
});

describe('adaptiveScorer batch weight lookup', () => {
  let db: Database.Database;
  let prepareCalls = 0;

  beforeEach(async () => {
    prepareCalls = 0;
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_performance_summary (
        agent_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        avg_quality REAL NOT NULL,
        success_rate REAL NOT NULL,
        total_runs INTEGER NOT NULL,
        avg_duration_ms REAL NOT NULL DEFAULT 0,
        p95_quality REAL NOT NULL DEFAULT 0,
        last_updated TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE agent_evolution_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        success INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const freshAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO agent_performance_summary
        (agent_id, task_type, avg_quality, success_rate, total_runs, last_updated)
      VALUES
        ('codex', 'code', 80, 0.9, 20, ?),
        ('opencode', 'code', 70, 0.8, 15, ?),
        ('ollama', 'code', 60, 0.7, 10, ?)
    `).run(freshAt, freshAt, freshAt);

    vi.doMock('../storage/database.js', () => ({
      getDb: () => {
        const originalPrepare = db.prepare.bind(db);
        return {
          prepare: (sql: string) => {
            prepareCalls += 1;
            return originalPrepare(sql);
          },
        };
      },
    }));
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../storage/database.js');
    vi.resetModules();
    db.close();
  });

  it('returns identical weights for batch and single-agent lookups', async () => {
    const { adaptiveScorer } = await import('./adaptive-scorer.js');
    const agentIds = ['codex', 'opencode', 'ollama'];
    const batch = adaptiveScorer.getWeightsForTask(agentIds, 'code');
    const singles = Object.fromEntries(
      agentIds.map((id) => [id, adaptiveScorer.getWeight(id, 'code')]),
    );
    expect(batch).toEqual(singles);
  });

  it('uses at most two SQL prepares for multi-agent batch lookup', async () => {
    const { adaptiveScorer } = await import('./adaptive-scorer.js');
    prepareCalls = 0;
    adaptiveScorer.getWeightsForTask(['codex', 'opencode', 'ollama'], 'code');
    expect(prepareCalls).toBeLessThanOrEqual(2);
  });
});

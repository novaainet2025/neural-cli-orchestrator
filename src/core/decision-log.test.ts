import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getDbMock = vi.hoisted(() => vi.fn());

vi.mock('../storage/database.js', () => ({ getDb: getDbMock }));
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { logDecision } from './decision-log.js';

describe('logDecision', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE decision_log (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        phase TEXT,
        decision TEXT NOT NULL,
        reason TEXT,
        evidence_tier TEXT,
        actor TEXT NOT NULL DEFAULT 'system',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    getDbMock.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    getDbMock.mockReset();
  });

  it('persists a routing decision with defaults applied', () => {
    logDecision({
      taskId: 'task_abc',
      phase: 'routing',
      decision: 'route:codex->mlx',
      reason: 'gated:quota',
    });

    const row = db.prepare('SELECT * FROM decision_log').get() as Record<string, unknown>;
    expect(row.task_id).toBe('task_abc');
    expect(row.phase).toBe('routing');
    expect(row.decision).toBe('route:codex->mlx');
    expect(row.reason).toBe('gated:quota');
    expect(row.actor).toBe('system');
    expect(typeof row.id).toBe('string');
  });

  it('records custom actor and evidence tier', () => {
    logDecision({
      decision: 'circuit:open',
      actor: 'codex',
      evidenceTier: 'T1',
    });

    const row = db.prepare('SELECT actor, evidence_tier, task_id FROM decision_log').get() as Record<string, unknown>;
    expect(row.actor).toBe('codex');
    expect(row.evidence_tier).toBe('T1');
    expect(row.task_id).toBeNull();
  });

  it('swallows database failures without throwing (non-blocking)', () => {
    db.exec('DROP TABLE decision_log');
    expect(() => logDecision({ decision: 'gate:quality_reject' })).not.toThrow();
  });
});

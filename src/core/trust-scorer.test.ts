import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getDbMock = vi.hoisted(() => vi.fn());

vi.mock('../storage/database.js', () => ({ getDb: getDbMock }));

import { computeTrustScores } from './trust-scorer.js';

describe('computeTrustScores', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tasks (
        assigned_to TEXT,
        status TEXT NOT NULL,
        response TEXT,
        verifier_result_json TEXT
      )
    `);
    getDbMock.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    getDbMock.mockReset();
  });

  it('computes verified success rate and completion-claim accuracy', () => {
    const insert = db.prepare(`
      INSERT INTO tasks (assigned_to, status, response, verifier_result_json)
      VALUES (?, 'completed', ?, ?)
    `);

    for (let index = 0; index < 10; index += 1) {
      const passed = index !== 5 && index !== 9;
      const response = index < 6 ? 'done: verified result' : 'status: result recorded';
      insert.run('trust-agent-metrics', response, JSON.stringify({ passed }));
    }

    const scores = computeTrustScores('trust-agent-metrics');

    expect(scores).not.toBeNull();
    expect(scores?.verifiedSr).toBe(0.8);
    expect(scores?.claimAccuracy).toBeCloseTo(5 / 6);
    expect(scores?.sampleSize).toBe(10);
  });

  it('returns null when fewer than ten verified tasks exist', () => {
    const insert = db.prepare(`
      INSERT INTO tasks (assigned_to, status, response, verifier_result_json)
      VALUES (?, 'completed', '완료', '{"passed":true}')
    `);

    for (let index = 0; index < 9; index += 1) {
      insert.run('trust-agent-small-sample');
    }

    expect(computeTrustScores('trust-agent-small-sample')).toBeNull();
  });
});

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { transitionTask } from './task-state.js';

describe('transitionTask', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function createTask(status = 'running'): Database.Database {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        response TEXT,
        error TEXT,
        evidence_json TEXT,
        team_id TEXT,
        metadata_json TEXT,
        updated_at TEXT,
        completed_at TEXT
      );
      INSERT INTO tasks (id, status) VALUES ('task-1', '${status}');
    `);
    return db;
  }

  it.each([undefined, '', '   '])(
    'persists an actionable fallback when a failed transition receives %j',
    (error) => {
      const database = createTask();

      const result = transitionTask(database, 'task-1', 'failed', {
        error,
        completedAt: true,
      });

      expect(result).toEqual({ ok: true });
      expect(database.prepare(
        'SELECT status, error FROM tasks WHERE id=?',
      ).get('task-1')).toEqual({
        status: 'failed',
        error: 'unknown: failure reason unavailable',
      });
    },
  );

  it('preserves a concrete failure reason', () => {
    const database = createTask();

    transitionTask(database, 'task-1', 'failed', {
      error: 'provider connection refused',
    });

    expect(database.prepare('SELECT error FROM tasks WHERE id=?').get('task-1'))
      .toEqual({ error: 'provider connection refused' });
  });

  it('allows an unclaimed pending task to be failed for safe replacement', () => {
    const database = createTask('pending');

    expect(transitionTask(database, 'task-1', 'failed', {
      error: 'replaced before assignment',
      completedAt: true,
    })).toEqual({ ok: true });
    expect(database.prepare('SELECT status, error FROM tasks WHERE id=?').get('task-1'))
      .toEqual({ status: 'failed', error: 'replaced before assignment' });
  });

  it.each(['assigned', 'running', 'streaming'])(
    'allows an execution lease to expire from %s',
    (status) => {
      const database = createTask(status);

      expect(transitionTask(database, 'task-1', 'lease_expired', {
        error: 'lease_expired',
        completedAt: true,
      })).toEqual({ ok: true });
      expect(database.prepare('SELECT status, error FROM tasks WHERE id=?').get('task-1'))
        .toEqual({ status: 'lease_expired', error: 'lease_expired' });
    },
  );

  it('keeps reviewing outside the execution-lease terminal transition', () => {
    const database = createTask('reviewing');

    expect(transitionTask(database, 'task-1', 'lease_expired', {
      error: 'lease_expired',
      completedAt: true,
    })).toEqual({ ok: false, prev: 'reviewing' });
    expect(database.prepare('SELECT status FROM tasks WHERE id=?').get('task-1'))
      .toEqual({ status: 'reviewing' });
  });

  it('stores task evidence as structured JSON when the ledger is available', () => {
    const database = createTask();
    database.exec(readFileSync(resolve('db/migrations/092_work_event_ledger.sql'), 'utf8'));

    transitionTask(database, 'task-1', 'completed', {
      response: 'done',
      completedAt: true,
      evidenceJson: '[{"tier":"T1","path":"/tmp/evidence.txt"}]',
    });

    const row = database.prepare(
      "SELECT evidence_json FROM work_events WHERE source='task-state' AND task_id='task-1'",
    ).get() as { evidence_json: string };
    expect(JSON.parse(row.evidence_json)).toEqual([
      { path: '/tmp/evidence.txt', tier: 'T1' },
    ]);
  });

  it('blocks team completion until an approved Nova-AX receipt is bound', () => {
    const database = createTask();
    database.prepare(`
      UPDATE tasks
      SET team_id='team-audit', metadata_json='{"verificationStatus":"pending"}'
      WHERE id='task-1'
    `).run();

    expect(transitionTask(database, 'task-1', 'completed')).toEqual({
      ok: false,
      prev: 'running',
    });
    expect(transitionTask(database, 'task-1', 'reviewing')).toEqual({ ok: true });

    database.prepare(`
      UPDATE tasks
      SET metadata_json='{"verificationStatus":"approved","verificationReceiptId":"receipt-6-of-6"}'
      WHERE id='task-1'
    `).run();
    expect(transitionTask(database, 'task-1', 'completed', {
      completedAt: true,
    })).toEqual({ ok: true });
  });
});

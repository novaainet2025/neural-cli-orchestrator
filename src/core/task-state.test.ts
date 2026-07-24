import Database from 'better-sqlite3';
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
});

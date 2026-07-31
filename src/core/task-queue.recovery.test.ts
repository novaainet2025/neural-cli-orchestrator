import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GRACEFUL_SHUTDOWN_INTERRUPTION,
  normalizeGracefulShutdownInterruption,
  persistRecoveredTaskResult,
} from './task-queue.js';

let db: Database.Database | null = null;

function createTask(status = 'running'): Database.Database {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      response TEXT,
      error TEXT,
      evidence_json TEXT,
      completed_at TEXT,
      updated_at TEXT,
      team_id TEXT,
      metadata_json TEXT
    );
    INSERT INTO tasks (id, status) VALUES ('recovered-task', '${status}');
  `);
  return db;
}

afterEach(() => {
  db?.close();
  db = null;
});

describe('persistRecoveredTaskResult', () => {
  it('stores a recovered success instead of leaving the task running', () => {
    const database = createTask();

    const moved = persistRecoveredTaskResult(database, 'recovered-task', {
      success: true,
      output: 'done: recovered output',
      status: 'completed',
      evidenceJson: '[{"tier":"T1"}]',
    });

    expect(moved).toEqual({ ok: true });
    expect(database.prepare(`
      SELECT status, response, error, evidence_json,
             completed_at IS NOT NULL AS completed
      FROM tasks WHERE id='recovered-task'
    `).get()).toEqual({
      status: 'completed',
      response: 'done: recovered output',
      error: null,
      evidence_json: '[{"tier":"T1"}]',
      completed: 1,
    });
  });

  it('stores the recovered failure reason and output', () => {
    const database = createTask();

    const moved = persistRecoveredTaskResult(database, 'recovered-task', {
      success: false,
      output: 'partial output',
      error: 'provider failed',
      status: 'failed',
    });

    expect(moved).toEqual({ ok: true });
    expect(database.prepare(`
      SELECT status, response, error, completed_at IS NOT NULL AS completed
      FROM tasks WHERE id='recovered-task'
    `).get()).toEqual({
      status: 'failed',
      response: 'partial output',
      error: 'provider failed',
      completed: 1,
    });
  });

  it('maps recovered timeout errors to timed_out', () => {
    const database = createTask();

    persistRecoveredTaskResult(database, 'recovered-task', {
      success: false,
      output: '',
      error: 'timeout(idle)',
    });

    expect(database.prepare(
      `SELECT status, error FROM tasks WHERE id='recovered-task'`,
    ).get()).toEqual({
      status: 'timed_out',
      error: 'timeout(idle)',
    });
  });

  it('persists a shutdown SIGINT as cancellation without a completion timestamp', () => {
    const database = createTask();
    const normalized = normalizeGracefulShutdownInterruption({
      success: false,
      output: '',
      error: 'opencode: CLI failed exit=unknown — Command was killed with SIGINT',
      status: 'failed',
    }, 'SIGINT');

    const moved = persistRecoveredTaskResult(database, 'recovered-task', normalized);

    expect(moved).toEqual({ ok: true });
    expect(database.prepare(`
      SELECT status, error, completed_at IS NOT NULL AS completed
      FROM tasks WHERE id='recovered-task'
    `).get()).toEqual({
      status: 'cancelled',
      error: `${GRACEFUL_SHUTDOWN_INTERRUPTION} (SIGINT)`,
      completed: 0,
    });
  });
});

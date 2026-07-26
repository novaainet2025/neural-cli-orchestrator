import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readRetryCount,
  reserveRetry,
  RETRY_LIFETIME_DEAD_LETTER_REASON,
  RETRY_LIFETIME_LIMIT,
  rollbackRetryReservation,
} from './retry-budget.js';

describe('bounded retry budget', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE retry_counts (
        task_id TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT,
        total_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        assigned_to TEXT,
        prompt TEXT NOT NULL
      );
      CREATE TABLE dead_letter_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        ai TEXT,
        prompt TEXT,
        reason TEXT
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('allows three retries in a six-hour window and rejects the fourth', () => {
    expect(reserveRetry(db, 'source-1')).toMatchObject({ allowed: true, count: 1 });
    expect(reserveRetry(db, 'source-1')).toMatchObject({ allowed: true, count: 2 });
    expect(reserveRetry(db, 'source-1')).toMatchObject({ allowed: true, count: 3 });
    expect(reserveRetry(db, 'source-1')).toEqual({
      allowed: false,
      count: 3,
      totalCount: 3,
      reason: 'window_limit',
    });
  });

  it('resets only the window count after six hours while preserving lifetime count', () => {
    reserveRetry(db, 'source-2');
    reserveRetry(db, 'source-2');
    db.prepare(
      `UPDATE retry_counts SET updated_at=datetime('now', '-7 hours') WHERE task_id=?`,
    ).run('source-2');

    expect(reserveRetry(db, 'source-2')).toEqual({
      allowed: true,
      count: 1,
      totalCount: 3,
    });
  });

  it('enforces the lifetime cap even after the current window expires', () => {
    db.prepare(
      `INSERT INTO tasks(id,assigned_to,prompt) VALUES ('source-3','codex','fix it')`,
    ).run();
    db.prepare(`
      INSERT INTO retry_counts(task_id,count,total_count,updated_at)
      VALUES (?, 1, ?, datetime('now', '-7 hours'))
    `).run('source-3', RETRY_LIFETIME_LIMIT);

    expect(reserveRetry(db, 'source-3')).toEqual({
      allowed: false,
      count: 0,
      totalCount: RETRY_LIFETIME_LIMIT,
      reason: 'lifetime_limit',
    });
    expect(db.prepare(`
      SELECT task_id, ai, prompt, reason
      FROM dead_letter_tasks
      WHERE task_id='source-3'
    `).get()).toEqual({
      task_id: 'source-3',
      ai: 'codex',
      prompt: 'fix it',
      reason: RETRY_LIFETIME_DEAD_LETTER_REASON,
    });

    reserveRetry(db, 'source-3');
    expect(db.prepare(`
      SELECT count(*) AS count
      FROM dead_letter_tasks
      WHERE task_id='source-3'
    `).get()).toEqual({ count: 1 });
  });

  it('rolls back both counters when retry task creation fails', () => {
    reserveRetry(db, 'source-4');
    rollbackRetryReservation(db, 'source-4');
    expect(readRetryCount(db, 'source-4')).toMatchObject({ count: 0, total_count: 0 });
  });

  it('migrates existing retry counts without losing their lifetime total', () => {
    const migrationDb = new Database(':memory:');
    try {
      migrationDb.exec(`
        CREATE TABLE retry_counts (
          task_id TEXT PRIMARY KEY,
          count INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO retry_counts(task_id,count) VALUES ('legacy-source', 7);
      `);
      migrationDb.exec(readFileSync(
        resolve(process.cwd(), 'db/migrations/089_failure_reliability.sql'),
        'utf8',
      ));

      expect(migrationDb.prepare(`
        SELECT count, total_count, updated_at IS NOT NULL AS has_updated_at
        FROM retry_counts
        WHERE task_id='legacy-source'
      `).get()).toEqual({
        count: 7,
        total_count: 7,
        has_updated_at: 1,
      });
    } finally {
      migrationDb.close();
    }
  });
});

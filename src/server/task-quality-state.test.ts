import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { markTaskQualityRejected } from './task-quality-state.js';

describe('task quality terminal state', () => {
  it('demotes a rejected completed task while preserving its response evidence', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        response TEXT,
        error TEXT,
        completed_at TEXT,
        updated_at TEXT
      );
      INSERT INTO tasks (id,status,response,completed_at)
      VALUES ('task-1','completed','bad but preserved','2026-07-26 00:00:00');
    `);

    expect(markTaskQualityRejected(db, 'task-1', ['FORMAT_MISMATCH'])).toBe(true);
    expect(db.prepare(
      'SELECT status,response,error FROM tasks WHERE id=?',
    ).get('task-1')).toEqual({
      status: 'failed',
      response: 'bad but preserved',
      error: 'quality_rejected: FORMAT_MISMATCH',
    });
    expect(markTaskQualityRejected(db, 'task-1', ['FORMAT_MISMATCH'])).toBe(false);
    db.close();
  });

  it('demotes a rejected reviewing task so the company orchestrator can retry it', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        response TEXT,
        error TEXT,
        completed_at TEXT,
        updated_at TEXT
      );
      INSERT INTO tasks (id,status,response)
      VALUES ('task-company-review','reviewing','tool echo preserved');
    `);

    expect(markTaskQualityRejected(
      db,
      'task-company-review',
      ['TOOL_CALL_ECHO'],
    )).toBe(true);
    expect(db.prepare(
      'SELECT status,response,error,completed_at IS NOT NULL AS terminalized FROM tasks WHERE id=?',
    ).get('task-company-review')).toEqual({
      status: 'failed',
      response: 'tool echo preserved',
      error: 'quality_rejected: TOOL_CALL_ECHO',
      terminalized: 1,
    });
    db.close();
  });
});

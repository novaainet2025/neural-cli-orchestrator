import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyWorkEvent,
  recordWorkEvent,
  redactSensitive,
} from './work-event-ledger.js';

describe('work event ledger', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(readFileSync(resolve('db/migrations/092_work_event_ledger.sql'), 'utf8'));
  });

  afterEach(() => db.close());

  it('records idempotently and maintains a hash chain', () => {
    const first = recordWorkEvent({
      eventKey: 'task:one:completed',
      source: 'test',
      sourceEventId: 'one',
      eventType: 'task:completed',
      title: 'Task one completed',
      taskId: 'one',
      detail: { output: 'done' },
      occurredAt: '2026-07-28T00:00:00.000Z',
    }, db);
    const duplicate = recordWorkEvent({
      eventKey: 'task:one:completed',
      source: 'test',
      sourceEventId: 'one',
      eventType: 'task:completed',
      title: 'ignored duplicate',
    }, db);
    const second = recordWorkEvent({
      eventKey: 'task:two:failed',
      source: 'test',
      eventType: 'task:failed',
      title: 'Task two failed',
    }, db);

    expect(duplicate.id).toBe(first.id);
    expect(second.previousHash).toBe(first.contentHash);
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_events').get()).toEqual({ n: 2 });
  });

  it('rejects update and delete attempts', () => {
    const event = recordWorkEvent({
      source: 'test',
      eventType: 'bug:observed',
      title: 'Bug observed',
    }, db);

    expect(() => db.prepare('UPDATE work_events SET title=? WHERE id=?').run('changed', event.id))
      .toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM work_events WHERE id=?').run(event.id))
      .toThrow(/append-only/);
  });

  it('classifies required operational event families', () => {
    expect(classifyWorkEvent('task:completed')).toBe('success');
    expect(classifyWorkEvent('task:failed')).toBe('failure');
    expect(classifyWorkEvent('learning:promoted')).toBe('improvement');
    expect(classifyWorkEvent('git:merge_conflict')).toBe('conflict');
    expect(classifyWorkEvent('worktree:dirty')).toBe('worktree');
    expect(classifyWorkEvent('test:regression')).toBe('regression');
    expect(classifyWorkEvent('bug:discovered')).toBe('bug');
  });

  it('redacts secret fields and token-shaped values', () => {
    const value = redactSensitive({
      authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
      nested: {
        apiKey: 'do-not-store',
        message: 'provider returned sk-test_abcdefghijklmnop',
        aws: 'AKIA1234567890ABCDEF',
        slack: 'xoxb-1234567890-abcdefghijkl',
      },
    });

    expect(value).toEqual({
      authorization: '[REDACTED]',
      nested: {
        apiKey: '[REDACTED]',
        message: 'provider returned [REDACTED]',
        aws: '[REDACTED]',
        slack: '[REDACTED]',
      },
    });
  });

  it('re-keys an ID collision instead of dropping either event', () => {
    const first = recordWorkEvent({
      id: 'evt-shared',
      eventKey: 'source-a:evt-shared',
      source: 'source-a',
      eventType: 'work:observed',
      title: 'First observation',
    }, db);
    const second = recordWorkEvent({
      id: 'evt-shared',
      eventKey: 'source-b:evt-shared',
      source: 'source-b',
      eventType: 'work:observed',
      title: 'Second observation',
    }, db);

    expect(first.id).toBe('evt-shared');
    expect(second.id).not.toBe(first.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_events').get()).toEqual({ n: 2 });
  });
});

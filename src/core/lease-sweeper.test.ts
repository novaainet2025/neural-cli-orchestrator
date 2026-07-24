import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { closeDb, getDb, runMigrations } from '../storage/database.js';
import { sweepExpiredTaskLeasesOnce } from './lease-sweeper.js';
import { env } from '../utils/config.js';
import { markTaskExecutionStarted } from './task-queue.js';
import { transitionTask } from './task-state.js';

describe.sequential('lease sweeper', () => {
  const testDbPath = resolve(env.ROOT, 'db/test-lease-sweeper.db');

  beforeAll(() => {
    closeDb();
    process.env.DATABASE_PATH = testDbPath;
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    delete process.env.DATABASE_PATH;
  });

  it('marks first expired lease and triggers failover callback once', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, lease_expires_at)
      VALUES (?, 'task', ?, ?, 'assigned', datetime('now', '-10 seconds'))
    `).run('lease-first', 'prompt', 'codex');

    const onLeaseExpired = vi.fn(async () => {});
    await sweepExpiredTaskLeasesOnce(onLeaseExpired);

    const row = db.prepare('SELECT status, error FROM tasks WHERE id=?').get('lease-first') as {
      status: string;
      error: string | null;
    };
    expect(row.status).toBe('lease_expired');
    expect(row.error).toBe('lease_expired');
    expect(onLeaseExpired).toHaveBeenCalledTimes(1);
    expect(onLeaseExpired).toHaveBeenCalledWith('lease-first');
  });

  it('fails the second expired lease in the same lineage', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, lease_expires_at)
      VALUES (?, 'task', ?, ?, 'lease_expired', datetime('now', '-1 minute'))
    `).run('lease-source', 'prompt', 'codex');
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, parent_task_id, lease_expires_at)
      VALUES (?, 'task', ?, ?, 'assigned', ?, datetime('now', '-10 seconds'))
    `).run('lease-second', 'prompt', 'codex', 'lease-source');

    const onLeaseExpired = vi.fn(async () => {});
    await sweepExpiredTaskLeasesOnce(onLeaseExpired);

    const row = db.prepare('SELECT status, error FROM tasks WHERE id=?').get('lease-second') as {
      status: string;
      error: string | null;
    };
    expect(row.status).toBe('failed');
    expect(row.error).toBe('lease_expired_twice');
    expect(onLeaseExpired).not.toHaveBeenCalled();
  });

  it('allows a recovered queued task to finish after worker start', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, orphan_requeue_count)
      VALUES (?, 'task', ?, ?, 'queued', 1)
    `).run('lease-recovered-queued', 'prompt', 'codex');

    const started = markTaskExecutionStarted('lease-recovered-queued');
    expect(started.ok).toBe(true);

    const running = db.prepare('SELECT status FROM tasks WHERE id=?')
      .get('lease-recovered-queued') as { status: string };
    expect(running.status).toBe('running');

    const completed = transitionTask(db, 'lease-recovered-queued', 'completed', {
      response: 'done: recovered task completed',
      completedAt: true,
    });
    expect(completed.ok).toBe(true);

    const terminal = db.prepare('SELECT status, response FROM tasks WHERE id=?')
      .get('lease-recovered-queued') as { status: string; response: string | null };
    expect(terminal).toEqual({
      status: 'completed',
      response: 'done: recovered task completed',
    });
  });
});

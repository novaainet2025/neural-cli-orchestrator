import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { closeDb, getDb, runMigrations } from '../storage/database.js';
import { LEASE_SWEEP_BATCH_LIMIT, sweepExpiredTaskLeasesOnce } from './lease-sweeper.js';
import { env } from '../utils/config.js';
import { markTaskExecutionStarted, taskQueue } from './task-queue.js';
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
    expect(onLeaseExpired).toHaveBeenCalledWith('lease-first', 'lease_expired');
  });

  it('expires an old unclaimed assignment but leaves a recent assignment alone', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, last_activity_at, updated_at)
      VALUES (?, 'task', ?, ?, 'assigned', datetime('now', '-11 minutes'), datetime('now', '-11 minutes'))
    `).run('claim-timeout-old', 'prompt', 'codex');
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, last_activity_at, updated_at)
      VALUES (?, 'task', ?, ?, 'assigned', datetime('now'), datetime('now'))
    `).run('claim-timeout-recent', 'prompt', 'codex');

    const onLeaseExpired = vi.fn(async () => {});
    await sweepExpiredTaskLeasesOnce(onLeaseExpired);

    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get('claim-timeout-old'))
      .toEqual({ status: 'lease_expired', error: 'claim_timeout' });
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get('claim-timeout-recent'))
      .toEqual({ status: 'assigned', error: null });
    expect(onLeaseExpired).toHaveBeenCalledWith('claim-timeout-old', 'claim_timeout');
  });

  it('expires running and streaming leases while leaving audit review to its reconciler', async () => {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, lease_expires_at)
      VALUES (?, 'task', ?, ?, ?, ?)
    `);
    insert.run('lease-running-expired', 'prompt', 'codex', 'running', '2000-01-01 00:00:00');
    insert.run('lease-streaming-expired', 'prompt', 'codex', 'streaming', '2000-01-01 00:00:00');
    insert.run('lease-reviewing-expired', 'prompt', 'codex', 'reviewing', '2000-01-01 00:00:00');
    insert.run('lease-running-recent', 'prompt', 'codex', 'running', '2999-01-01 00:00:00');

    const onLeaseExpired = vi.fn(async () => {});
    await sweepExpiredTaskLeasesOnce(onLeaseExpired);

    expect(onLeaseExpired).toHaveBeenCalledTimes(2);
    expect(onLeaseExpired).toHaveBeenCalledWith('lease-running-expired', 'lease_expired');
    expect(onLeaseExpired).toHaveBeenCalledWith('lease-streaming-expired', 'lease_expired');
    expect(db.prepare(`
      SELECT id, status
      FROM tasks
      WHERE id LIKE 'lease-%-expired'
      ORDER BY id
    `).all()).toEqual([
      { id: 'lease-reviewing-expired', status: 'reviewing' },
      { id: 'lease-running-expired', status: 'lease_expired' },
      { id: 'lease-streaming-expired', status: 'lease_expired' },
    ]);
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get('lease-running-recent'))
      .toEqual({ status: 'running' });
  });

  it('heartbeats a locally owned runtime before its first provider activity', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES (?, 'task', ?, ?, 'assigned')
    `).run('lease-cold-start-runtime', 'slow provider cold start', 'codex');
    const manager = taskQueue as any;
    const controller = new AbortController();

    try {
      manager.startRuntime({
        taskId: 'lease-cold-start-runtime',
        agentId: 'codex',
        prompt: 'slow provider cold start',
      }, controller);
      const row = db.prepare(`
        SELECT status, heartbeat_seq, last_heartbeat_at, lease_expires_at
        FROM tasks WHERE id='lease-cold-start-runtime'
      `).get() as {
        status: string;
        heartbeat_seq: number | null;
        last_heartbeat_at: string | null;
        lease_expires_at: string | null;
      };
      expect(row.status).toBe('running');
      expect(row.heartbeat_seq).toBe(1);
      expect(row.last_heartbeat_at).not.toBeNull();
      expect(row.lease_expires_at).not.toBeNull();
    } finally {
      manager.finalizeRuntime('lease-cold-start-runtime', {
        success: false,
        output: '',
        error: 'test cleanup',
        status: 'cancelled',
      });
    }
  });

  it('limits each sweep so a stale backlog cannot trigger a failover storm', async () => {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, last_activity_at, updated_at)
      VALUES (?, 'task', ?, ?, 'assigned', datetime('now', '-12 minutes'), datetime('now', '-12 minutes'))
    `);
    for (let index = 0; index < LEASE_SWEEP_BATCH_LIMIT + 2; index += 1) {
      insert.run(`claim-timeout-batch-${index}`, 'prompt', 'codex');
    }

    const firstSweep = vi.fn(async () => {});
    await sweepExpiredTaskLeasesOnce(firstSweep);

    expect(firstSweep).toHaveBeenCalledTimes(LEASE_SWEEP_BATCH_LIMIT);
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM tasks
      WHERE id LIKE 'claim-timeout-batch-%'
        AND status = 'assigned'
    `).get()).toEqual({ count: 2 });

    const secondSweep = vi.fn(async () => {});
    await sweepExpiredTaskLeasesOnce(secondSweep);

    expect(secondSweep).toHaveBeenCalledTimes(2);
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM tasks
      WHERE id LIKE 'claim-timeout-batch-%'
        AND status = 'assigned'
    `).get()).toEqual({ count: 0 });
  });

  it('fails the second expired lease in the same lineage', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, lease_expires_at)
      VALUES (?, 'task', ?, ?, 'lease_expired', datetime('now', '-1 minute'))
    `).run('lease-source', 'prompt', 'codex');
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, parent_task_id)
      VALUES (?, 'task', ?, ?, 'failed', ?)
    `).run('lease-legacy-middle', 'prompt', 'ollama', 'lease-source');
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, parent_task_id, lease_expires_at)
      VALUES (?, 'task', ?, ?, 'assigned', ?, datetime('now', '-10 seconds'))
    `).run('lease-second', 'prompt', 'codex', 'lease-legacy-middle');

    const onLeaseExpired = vi.fn(async () => {});
    await sweepExpiredTaskLeasesOnce(onLeaseExpired);

    const row = db.prepare('SELECT status, error FROM tasks WHERE id=?').get('lease-second') as {
      status: string;
      error: string | null;
    };
    expect(row.status).toBe('failed');
    expect(row.error).toBe('lease_expired_twice');
    expect(onLeaseExpired).toHaveBeenCalledOnce();
    expect(onLeaseExpired).toHaveBeenCalledWith('lease-second', 'lease_expired_twice');
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

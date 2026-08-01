import Database from 'better-sqlite3';
import { UnrecoverableError } from 'bullmq';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  BULLMQ_JOB_ATTEMPTS,
  BULLMQ_LOCK_DURATION_MS,
  Semaphore,
  captureVerifierBaseline,
  duplicateExecutionResultFromError,
  isDuplicateExecutionFailure,
  persistVerifierResultToDb,
  reconcileVerifierBaseline,
  resolveBullMqPrefix,
  runBestEffortSqliteWrite,
  shouldPurgeStartupActiveJob,
  shouldPurgeStaleJob,
  taskQueue,
  terminalDuplicateExecutionError,
} from './task-queue.js';

describe('task queue P1 reliability guards', () => {
  it('uses one BullMQ attempt and a lock two minutes beyond the hard timeout', () => {
    expect(BULLMQ_JOB_ATTEMPTS).toBe(1);
    expect(BULLMQ_LOCK_DURATION_MS).toBe(22 * 60_000);
  });

  it('purges only missing or terminal BullMQ jobs', () => {
    expect(shouldPurgeStaleJob(undefined)).toBe(true);
    expect(shouldPurgeStaleJob('completed')).toBe(true);
    expect(shouldPurgeStaleJob('failed')).toBe(true);
    expect(shouldPurgeStaleJob('running')).toBe(false);
    expect(shouldPurgeStaleJob('queued')).toBe(false);
  });

  it('reclaims startup active jobs only after DB orphan recovery', () => {
    expect(shouldPurgeStartupActiveJob(undefined)).toBe(true);
    expect(shouldPurgeStartupActiveJob('completed')).toBe(true);
    expect(shouldPurgeStartupActiveJob('queued')).toBe(true);
    expect(shouldPurgeStartupActiveJob('running')).toBe(false);
    expect(shouldPurgeStartupActiveJob('streaming')).toBe(false);
  });

  it('isolates BullMQ namespaces for every non-production SQLite database', () => {
    expect(resolveBullMqPrefix(resolve(process.cwd(), 'db/nco.db'))).toBe('bull');

    const first = resolveBullMqPrefix('/tmp/nco-isolated-a/db.sqlite');
    const second = resolveBullMqPrefix('/tmp/nco-isolated-b/db.sqlite');
    expect(first).toMatch(/^bull-nco-[a-f0-9]{16}$/);
    expect(resolveBullMqPrefix('/tmp/nco-isolated-a/db.sqlite')).toBe(first);
    expect(second).not.toBe(first);
  });

  it('supports a validated explicit BullMQ namespace override', () => {
    expect(resolveBullMqPrefix('/tmp/anything.sqlite', 'nco_ci_42')).toBe('nco_ci_42');
    expect(() => resolveBullMqPrefix('/tmp/anything.sqlite', 'shared:bull')).toThrow(
      'NCO_BULLMQ_PREFIX may contain only letters, numbers, _ and -',
    );
  });

  it('keeps best-effort SQLite activity writes from escaping the stream callback', () => {
    expect(runBestEffortSqliteWrite(() => {})).toEqual({ ok: true });

    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const busyResult = runBestEffortSqliteWrite(() => { throw busy; });
    expect(busyResult).toMatchObject({ ok: false, retryable: true, error: busy });

    const locked = Object.assign(new Error('another writer'), { code: 'SQLITE_LOCKED' });
    expect(runBestEffortSqliteWrite(() => { throw locked; })).toMatchObject({
      ok: false,
      retryable: true,
    });

    const invalid = new Error('no such table: tasks');
    expect(runBestEffortSqliteWrite(() => { throw invalid; })).toMatchObject({
      ok: false,
      retryable: false,
      error: invalid,
    });
  });

  it('returns BullMQ UnrecoverableError for terminal or missing durable task execution', () => {
    const error = terminalDuplicateExecutionError('task-1', 'completed');
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error?.message).toBe(
      'duplicate_execution: task task-1 already terminal (completed)',
    );
    expect(terminalDuplicateExecutionError('task-1', 'running')).toBeNull();
    expect(terminalDuplicateExecutionError('task-missing', undefined)?.message).toBe(
      'duplicate_execution: task task-missing has no durable task row',
    );
    expect(isDuplicateExecutionFailure({
      success: false,
      error: error?.message,
    })).toBe(true);
    expect(isDuplicateExecutionFailure({
      success: false,
      error: 'provider failed',
    })).toBe(false);
    expect(duplicateExecutionResultFromError(error)).toEqual({
      success: false,
      output: '',
      error: error?.message,
    });
    expect(duplicateExecutionResultFromError(new Error('provider failed'))).toBeNull();
  });

  it('captures a fresh verifier baseline for each task execution', async () => {
    const task = {
      taskId: 'baseline-task',
      agentId: 'codex',
      prompt: 'test',
      verifier: {
        type: 'run' as const,
        command: 'false',
        timeoutMs: 5_000,
      },
      metadata: {},
    };

    const first = await captureVerifierBaseline(task, new AbortController().signal);
    const second = await captureVerifierBaseline(task, new AbortController().signal);

    expect(first).toMatchObject({
      code: 1,
      timedOut: false,
    });
    expect(second).toMatchObject({
      code: 1,
      timedOut: false,
    });
    expect(second).not.toBe(first);
  });

  it('passes the task abort signal to the pre-task baseline child', async () => {
    const controller = new AbortController();
    const baseline = captureVerifierBaseline({
      taskId: 'aborted-baseline-task',
      agentId: 'codex',
      prompt: 'test',
      verifier: {
        type: 'run',
        command: 'sleep 5',
        timeoutMs: 10_000,
      },
      metadata: {},
    }, controller.signal);

    controller.abort(new Error('cancelled'));

    await expect(baseline).resolves.toBeNull();
  });

  it('cancels a semaphore waiter without consuming the next provider slot', async () => {
    const manager = taskQueue as any;
    const originalAgents = manager.agents;
    const semaphore = new Semaphore(1);
    expect(await semaphore.acquire('active-task')).toBe(true);
    const waiting = semaphore.acquire('waiting-task');
    manager.agents = new Map([
      ['codex', {
        semaphore,
        activeControllers: new Map(),
        mode: 'semaphore',
        waiting: 1,
      }],
    ]);

    try {
      await expect(manager.abort('waiting-task')).resolves.toBe(true);
      await expect(waiting).resolves.toBe(false);
      semaphore.release();
      await expect(semaphore.acquire('next-task')).resolves.toBe(true);
      semaphore.release();
    } finally {
      manager.agents = originalAgents;
    }
  });

  it('settles a removed BullMQ waiter immediately as cancelled exactly once', async () => {
    const manager = taskQueue as any;
    const originalAgents = manager.agents;
    const originalAborters = manager.waitingBullMqAborters;
    const queueEvents = new EventEmitter();
    const task = {
      taskId: 'waiting-bull-task',
      agentId: 'codex',
      prompt: 'test',
      metadata: { queueWaitMaxMs: 30_000 },
    };
    const job = {
      id: task.taskId,
      data: task,
      getState: vi.fn().mockResolvedValue('waiting'),
      remove: vi.fn().mockResolvedValue(undefined),
      waitUntilFinished: vi.fn(),
    };
    const queue = {
      add: vi.fn().mockResolvedValue(job),
      getJob: vi.fn().mockResolvedValue(job),
    };
    const entry = {
      queue,
      queueEvents,
      semaphore: new Semaphore(1),
      activeControllers: new Map(),
      mode: 'bullmq',
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      concurrency: 1,
      configuredConcurrency: 1,
    };
    manager.waitingBullMqAborters = new Map();
    manager.agents = new Map([['codex', entry]]);

    try {
      const pending = manager.enqueueBullMQ(task, entry);
      await vi.waitFor(() => {
        expect(manager.waitingBullMqAborters.has(task.taskId)).toBe(true);
      });
      await expect(manager.abort(task.taskId)).resolves.toBe(true);
      await expect(pending).resolves.toEqual({
        success: false,
        output: '',
        error: 'cancelled',
        status: 'cancelled',
      });
      expect(job.remove).toHaveBeenCalledOnce();
      expect(job.waitUntilFinished).not.toHaveBeenCalled();
      expect(entry.waiting).toBe(0);
      expect(entry.failed).toBe(0);
      expect(queueEvents.listenerCount('active')).toBe(0);
      expect(manager.waitingBullMqAborters.has(task.taskId)).toBe(false);
    } finally {
      manager.agents = originalAgents;
      manager.waitingBullMqAborters = originalAborters;
    }
  });

  it('records why a failed verifier is skipped when clean HEAD also fails', () => {
    const result = reconcileVerifierBaseline({
      type: 'run',
      command: 'npx tsc --noEmit',
      timeoutMs: 60_000,
      startedAt: '2026-07-26T00:00:00.000Z',
      exitCode: 2,
      timedOut: false,
      passed: false,
      outputSnippet: 'TS2322',
    }, {
      code: 2,
      timedOut: false,
    }, {
      code: 2,
      timedOut: false,
    });

    expect(result).toMatchObject({
      passed: true,
      verifier_skipped: 'pre-existing build failure',
    });

    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          verifier_result_json TEXT,
          updated_at TEXT
        );
        INSERT INTO tasks(id) VALUES ('task-with-dirty-baseline');
      `);
      persistVerifierResultToDb(db, 'task-with-dirty-baseline', result);
      const row = db.prepare(`
        SELECT verifier_result_json
        FROM tasks
        WHERE id='task-with-dirty-baseline'
      `).get() as { verifier_result_json: string };

      expect(JSON.parse(row.verifier_result_json)).toMatchObject({
        passed: true,
        verifier_skipped: 'pre-existing build failure',
      });
    } finally {
      db.close();
    }
  });

  it('keeps the verifier failure fail-closed when the HEAD baseline is indeterminate', () => {
    const result = reconcileVerifierBaseline({
      type: 'run',
      command: 'npx tsc --noEmit',
      timeoutMs: 60_000,
      startedAt: '2026-07-26T00:00:00.000Z',
      exitCode: 2,
      timedOut: false,
      passed: false,
      outputSnippet: 'TS2322',
    }, {
      code: 2,
      timedOut: false,
    }, null);

    expect(result).toMatchObject({
      passed: false,
      baseline_indeterminate: 'HEAD-clean verifier baseline unavailable or inconclusive',
    });
    expect(result).not.toHaveProperty('verifier_skipped');
  });
});

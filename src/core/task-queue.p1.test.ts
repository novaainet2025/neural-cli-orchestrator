import Database from 'better-sqlite3';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  BULLMQ_JOB_ATTEMPTS,
  BULLMQ_LOCK_DURATION_MS,
  captureVerifierBaseline,
  duplicateExecutionResultFromError,
  isDuplicateExecutionFailure,
  persistVerifierResultToDb,
  reconcileVerifierBaseline,
  shouldPurgeStaleJob,
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

  it('returns BullMQ UnrecoverableError only for terminal duplicate execution', () => {
    const error = terminalDuplicateExecutionError('task-1', 'completed');
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error?.message).toBe(
      'duplicate_execution: task task-1 already terminal (completed)',
    );
    expect(terminalDuplicateExecutionError('task-1', 'running')).toBeNull();
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

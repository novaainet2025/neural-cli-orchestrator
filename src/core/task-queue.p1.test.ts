import Database from 'better-sqlite3';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import {
  BULLMQ_JOB_ATTEMPTS,
  BULLMQ_LOCK_DURATION_MS,
  getVerifierBaseline,
  isDuplicateExecutionFailure,
  persistVerifierResultToDb,
  reconcileVerifierBaseline,
  shouldPurgeStaleJob,
  terminalDuplicateExecutionError,
  VERIFIER_BASELINE_TTL_MS,
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
  });

  it('caches a verifier baseline by cwd and command for 60 seconds', async () => {
    const run = vi.fn().mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'build failed',
      timedOut: false,
    });
    const now = 1_000_000;

    await getVerifierBaseline('/repo-a', 'npm test', run, now);
    await getVerifierBaseline('/repo-a', 'npm test', run, now + VERIFIER_BASELINE_TTL_MS - 1);
    expect(run).toHaveBeenCalledTimes(1);

    await getVerifierBaseline('/repo-a', 'npm test', run, now + VERIFIER_BASELINE_TTL_MS);
    await getVerifierBaseline('/repo-b', 'npm test', run, now + VERIFIER_BASELINE_TTL_MS);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('records why a failed verifier is skipped when the baseline also fails', () => {
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
});

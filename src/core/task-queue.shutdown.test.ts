import { describe, expect, it, vi } from 'vitest';
import {
  GRACEFUL_SHUTDOWN_INTERRUPTION,
  normalizeGracefulShutdownInterruption,
  taskQueue,
} from './task-queue.js';

describe('normalizeGracefulShutdownInterruption', () => {
  it.each([
    'opencode: CLI failed exit=unknown — Command was killed with SIGINT',
    'cursor-agent: CLI failed exit=130 — Aborting operation...',
    'subprocess exited with code unknown: Command was killed with SIGINT',
  ])('classifies a process-group interruption as shutdown cancellation: %s', error => {
    expect(normalizeGracefulShutdownInterruption({
      success: false,
      output: '',
      error,
      status: 'failed',
    }, 'SIGINT')).toEqual({
      success: false,
      output: '',
      error: `${GRACEFUL_SHUTDOWN_INTERRUPTION} (SIGINT)`,
      status: 'cancelled',
    });
  });

  it('does not hide an unrelated provider failure during shutdown', () => {
    const result = {
      success: false,
      output: '',
      error: 'provider returned invalid response',
      status: 'failed' as const,
    };

    expect(normalizeGracefulShutdownInterruption(result, 'SIGTERM')).toBe(result);
  });

  it('does not rewrite an interruption without an active shutdown', () => {
    const result = {
      success: false,
      output: '',
      error: 'cursor-agent: CLI failed exit=130 — Aborting operation...',
      status: 'failed' as const,
    };

    expect(normalizeGracefulShutdownInterruption(result, null)).toBe(result);
  });

  it('preserves a success completed during shutdown drain', () => {
    const result = {
      success: true,
      output: 'done: verified',
      status: 'completed' as const,
    };

    expect(normalizeGracefulShutdownInterruption(result, 'SIGINT')).toBe(result);
  });

  it('does not escalate a cancellation to another provider during shutdown', async () => {
    const manager = taskQueue as any;
    const runEnqueue = manager.runEnqueue;
    const tryTierEscalation = manager.tryTierEscalation;
    manager.runEnqueue = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: `${GRACEFUL_SHUTDOWN_INTERRUPTION} (SIGINT)`,
      status: 'cancelled',
    });
    manager.tryTierEscalation = vi.fn();

    try {
      await expect(manager.enqueue({
        taskId: 'shutdown-cancelled-task',
        agentId: 'opencode',
        prompt: 'test',
      })).resolves.toMatchObject({ status: 'cancelled' });
      expect(manager.tryTierEscalation).not.toHaveBeenCalled();
      expect(manager.runEnqueue).toHaveBeenCalledTimes(1);
    } finally {
      manager.runEnqueue = runEnqueue;
      manager.tryTierEscalation = tryTierEscalation;
    }
  });
});

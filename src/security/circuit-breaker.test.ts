import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../storage/database.js', () => ({
  getDb: () => { throw new Error('database unavailable in unit test'); },
}));
vi.mock('../core/shared-state.js', () => ({
  sharedState: { setAgentState: vi.fn(async () => undefined) },
}));
vi.mock('../core/event-bus.js', () => ({
  eventBus: { publish: vi.fn(async () => undefined) },
}));
vi.mock('../core/decision-log.js', () => ({ logDecision: vi.fn() }));
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { CircuitBreaker } from './circuit-breaker.js';

describe('CircuitBreaker configuration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the configured threshold, reset timeout, and half-open attempt cap', () => {
    const breaker = new CircuitBreaker('configured-test', {
      failureThreshold: 2,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    breaker.reset();

    breaker.recordFailure('first');
    expect(breaker.getState()).toBe('closed');
    breaker.recordFailure('second');
    expect(breaker.getState()).toBe('open');
    expect(breaker.canExecute()).toBe(false);

    vi.advanceTimersByTime(50);
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.getState()).toBe('half-open');
    expect(breaker.canExecute()).toBe(false);

    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
  });
});

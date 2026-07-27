import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const learnedPattern = vi.hoisted(() => ({
  signature: null as string | null,
}));

vi.mock('../storage/database.js', () => ({
  getDb: () => { throw new Error('database unavailable in unit test'); },
}));
vi.mock('../core/failure-learning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/failure-learning.js')>();
  return {
    ...actual,
    matchLearnedCircuitPattern: vi.fn((raw: string | null | undefined) => {
      const signature = raw?.trim();
      if (!learnedPattern.signature || signature !== learnedPattern.signature) {
        return actual.matchLearnedCircuitPattern(raw);
      }
      return {
        signature,
        sourceCount: 3,
        firstSeen: '2026-01-01 00:00:00',
        lastSeen: '2026-01-01 00:00:00',
        regex: new RegExp(`^${signature}$`, 'u'),
        reason: 'generic',
        immediateOpen: false,
        failureThreshold: 2,
      };
    }),
  };
});
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
import { circuitBreakerRegistry } from './circuit-breaker-registry.js';

describe('CircuitBreaker configuration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    learnedPattern.signature = null;
  });

  afterEach(() => {
    learnedPattern.signature = null;
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

  it('opens on the second exact learned failure without immediate-opening on the first', () => {
    const signature = 'repeated exact transient failure';
    learnedPattern.signature = signature;
    const breaker = new CircuitBreaker('learned-threshold-test', {
      failureThreshold: 3,
    });
    breaker.reset();

    breaker.recordFailure(signature);
    expect(breaker.getState()).toBe('closed');
    expect(breaker.getFailures()).toBe(1);

    breaker.recordFailure(signature);
    expect(breaker.getState()).toBe('open');
    expect(circuitBreakerRegistry.getSnapshot('learned-threshold-test').reason).toBe('generic');
  });

  // P0-3: halfOpenAttempts는 누적 카운터가 아니라 in-flight 세마포어다. 슬롯을 획득한
  // 실행이 끝나면 releaseProbeSlot()으로 반드시 반납해야, 그 세션이 끝난 뒤 새 프로브가
  // 진행될 수 있다 — 반납 누락이 half-open 영구 고착의 근본 원인이었다.
  it('releases the held half-open probe slot so a subsequent probe can proceed', () => {
    const breaker = new CircuitBreaker('probe-slot-release-test', {
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    breaker.reset();

    breaker.recordFailure('boom');
    expect(breaker.getState()).toBe('open');

    vi.advanceTimersByTime(50);
    expect(breaker.canExecute()).toBe(true); // 유일한 프로브 슬롯 획득
    expect(breaker.getState()).toBe('half-open');
    expect(breaker.canExecute()).toBe(false); // 슬롯이 이미 점유됨 — 두 번째 동시 프로브 불가

    circuitBreakerRegistry.releaseProbeSlot('probe-slot-release-test');
    expect(breaker.canExecute()).toBe(true); // 반납 후 새 프로브 진행 가능
  });

  // 반납 위치를 잘못 잡으면(획득하지 않은 경로에서 반납) 카운터가 음수로 내려가 canExecute()가
  // 무제한으로 true를 반환할 위험이 있다 — releaseProbeSlot()은 held slot이 없을 때 no-op이어야
  // 하고, in-flight 한도(halfOpenMaxAttempts)는 그대로 유지되어야 한다.
  it('does not underflow when releasing a slot that was never acquired', () => {
    const breaker = new CircuitBreaker('probe-slot-unheld-test', {
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    breaker.reset();

    circuitBreakerRegistry.releaseProbeSlot('probe-slot-unheld-test'); // no-op, must not underflow

    breaker.recordFailure('boom');
    vi.advanceTimersByTime(50);
    expect(breaker.canExecute()).toBe(true); // 여전히 정확히 1개 슬롯만 허용
    expect(breaker.canExecute()).toBe(false); // 한도 초과 — 무제한 동시 실행 아님
  });

  it('starts the half-open TTL when the probe state begins, not when the circuit first opened', () => {
    const breaker = new CircuitBreaker('probe-ttl-start-test', {
      failureThreshold: 1,
      resetTimeoutMs: 10 * 60_000,
      halfOpenMaxAttempts: 1,
    });
    breaker.reset();

    breaker.recordFailure('boom');
    vi.advanceTimersByTime(10 * 60_000);
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.getState()).toBe('half-open');
  });

  // Regression test for A (half-open probe slot): getSnapshot() is a
  // non-mutating observer that must NOT consume a probe slot. Only
  // canExecute() should consume it. Without this guard, a nested
  // getSnapshot() call inside the probe execution would starve the
  // sole half-open slot and prevent circuit recovery.
  it('getSnapshot() does not consume the half-open probe slot', () => {
    const breaker = new CircuitBreaker('half-open-slot-test', {
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    breaker.reset();

    breaker.recordFailure('boom');
    expect(breaker.getState()).toBe('open');

    vi.advanceTimersByTime(50);

    // Acquire the sole probe slot — first canExecute() returns true
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.getState()).toBe('half-open');

    // getSnapshot() (simulating nested observation) must NOT consume a slot
    // Second canExecute() must still return false
    expect(breaker.getState()).toBe('half-open'); // observation, no slot consumed
    expect(breaker.canExecute()).toBe(false); // slot still held

    // Release the probe slot
    circuitBreakerRegistry.releaseProbeSlot('half-open-slot-test');
    expect(breaker.canExecute()).toBe(true); // new probe can proceed
  });

  it('keeps a live probe half-open past TTL and rejects a second probe', () => {
    const breaker = new CircuitBreaker('live-probe-ttl-test', {
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    const controller = new AbortController();
    breaker.reset();
    breaker.recordFailure('boom');
    vi.advanceTimersByTime(50);

    expect(breaker.canExecute()).toBe(true);
    expect(circuitBreakerRegistry.bindProbeSlot(
      'live-probe-ttl-test',
      controller.signal,
    )).toBe(true);

    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(breaker.getState()).toBe('half-open');
    expect(breaker.canExecute()).toBe(false);

    controller.abort();
    expect(breaker.getState()).toBe('closed');
  });

  it('reclaims an abandoned half-open slot after the five-minute TTL', () => {
    const breaker = new CircuitBreaker('abandoned-probe-ttl-test', {
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    breaker.reset();
    breaker.recordFailure('boom');
    vi.advanceTimersByTime(50);

    expect(breaker.canExecute()).toBe(true);
    expect(breaker.getState()).toBe('half-open');

    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(breaker.getState()).toBe('closed');
    expect(breaker.canExecute()).toBe(true);
  });
});

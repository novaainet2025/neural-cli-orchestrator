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
import { circuitBreakerRegistry } from './circuit-breaker-registry.js';

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
});

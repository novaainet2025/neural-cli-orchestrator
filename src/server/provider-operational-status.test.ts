import { describe, expect, it } from 'vitest';
import type { ProviderAvailabilitySnapshot } from '../security/circuit-breaker-registry.js';
import {
  PROVIDER_WORK_FRESHNESS_MS,
  providerOperationalGuidance,
  resolveProviderLimitStatus,
  resolveProviderWorkStatus,
} from './provider-operational-status.js';

const NOW = Date.parse('2026-08-03T03:00:00.000Z');

function availability(
  status: ProviderAvailabilitySnapshot['status'],
  overrides: Partial<ProviderAvailabilitySnapshot> = {},
): ProviderAvailabilitySnapshot {
  return {
    agentId: 'codex',
    status,
    available: status === 'available',
    reason: null,
    circuitState: status === 'available' ? 'closed' : status === 'probe' ? 'half-open' : 'open',
    cooldownUntil: null,
    ...overrides,
  };
}

describe('provider operational status', () => {
  it('does not treat an expired durable record as a current limit', () => {
    const limit = resolveProviderLimitStatus({
      availability: availability('available'),
      staleRecord: true,
      nowMs: NOW,
    });

    expect(limit).toMatchObject({
      status: 'available',
      limited: false,
      availableForNewWork: true,
      staleRecord: true,
    });
    expect(providerOperationalGuidance(resolveProviderWorkStatus({ nowMs: NOW }), limit))
      .toContain('과거 리밋 기록');
  });

  it('reports a future durable rate limit with an actionable retry time', () => {
    const limit = resolveProviderLimitStatus({
      availability: availability('available'),
      durableRateLimit: {
        resetAt: '2026-08-03T04:00:00.000Z',
        reason: 'rate-limit',
        updatedAt: '2026-08-03T02:59:00.000Z',
      },
      nowMs: NOW,
    });

    expect(limit).toMatchObject({
      status: 'limited',
      limited: true,
      availableForNewWork: false,
      retryAt: '2026-08-03T04:00:00.000Z',
      evidence: 'durable-rate-limit',
    });
    expect(providerOperationalGuidance(resolveProviderWorkStatus({ nowMs: NOW }), limit))
      .toContain('2026-08-03T04:00:00.000Z 이후');
  });

  it('separates a loaded runtime from lease-backed active work', () => {
    expect(resolveProviderWorkStatus({ sharedStatus: 'idle', nowMs: NOW })).toMatchObject({
      status: 'idle',
      active: false,
      evidence: 'no-live-execution',
    });
    expect(resolveProviderWorkStatus({
      liveTask: { id: 'task-live', prompt: 'compile release', status: 'running' },
      nowMs: NOW,
    })).toMatchObject({
      status: 'working',
      active: true,
      evidence: 'lease-backed-task',
      taskId: 'task-live',
    });
  });

  it('downgrades stale remote or shared working signals to unknown', () => {
    const stale = new Date(NOW - PROVIDER_WORK_FRESHNESS_MS - 1).toISOString();
    expect(resolveProviderWorkStatus({
      pushed: { status: 'working', currentTask: 'old task', reportedAt: stale },
      sharedStatus: 'working',
      nowMs: NOW,
    })).toMatchObject({
      status: 'unknown',
      active: null,
      freshness: 'stale',
      evidence: 'stale-working-signal',
      currentTask: null,
    });
  });

  it('does not reinterpret a recent done message as active work', () => {
    expect(resolveProviderWorkStatus({
      session: {
        status: 'working',
        currentTask: 'done: previous task',
        observedAt: new Date(NOW - 10_000).toISOString(),
        ageMs: 10_000,
        source: 'done/answer-recent',
      },
      nowMs: NOW,
    })).toMatchObject({
      status: 'idle',
      active: false,
      evidence: 'no-live-execution',
    });
  });

  it('labels an expired still-gated cooldown as inconsistent, not limited', () => {
    expect(resolveProviderLimitStatus({
      availability: availability('gated:quota', {
        reason: 'quota',
        cooldownUntil: '2026-08-03T02:00:00.000Z',
      }),
      nowMs: NOW,
    })).toMatchObject({
      status: 'inconsistent',
      limited: null,
      availableForNewWork: false,
      evidence: 'inconsistent-expired-gate',
    });
  });
});

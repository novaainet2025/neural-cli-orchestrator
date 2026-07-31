import { describe, expect, it } from 'vitest';
import type { ProviderAvailabilitySnapshot } from '../security/circuit-breaker-registry.js';
import { summarizeProviderAvailability } from './provider-health.js';

function availability(
  agentId: string,
  status: ProviderAvailabilitySnapshot['status'],
): ProviderAvailabilitySnapshot {
  return {
    agentId,
    status,
    available: status === 'available',
    reason: status === 'gated:quota' ? 'quota' : null,
    circuitState: status === 'available' ? 'closed' : status === 'probe' ? 'half-open' : 'open',
    cooldownUntil: status === 'gated:quota' ? '2026-08-01T00:00:00.000Z' : null,
  };
}

describe('summarizeProviderAvailability', () => {
  it('separates available, probing, and gated providers', () => {
    const snapshots = new Map([
      ['codex', availability('codex', 'available')],
      ['cursor-agent', availability('cursor-agent', 'gated:quota')],
      ['hermes', availability('hermes', 'probe')],
    ]);

    expect(summarizeProviderAvailability(
      ['codex', 'cursor-agent', 'hermes'],
      id => snapshots.get(id)!,
    )).toEqual({
      basis: 'circuit-breaker-admission',
      liveProbe: false,
      configured: 3,
      available: 1,
      probing: ['hermes'],
      unavailable: [
        {
          id: 'cursor-agent',
          status: 'gated:quota',
          reason: 'quota',
          cooldownUntil: '2026-08-01T00:00:00.000Z',
        },
        {
          id: 'hermes',
          status: 'probe',
          reason: null,
          cooldownUntil: null,
        },
      ],
    });
  });

  it('reports an availability lookup failure without failing health', () => {
    expect(summarizeProviderAvailability(['codex'], () => {
      throw new Error('database unavailable');
    })).toEqual({
      basis: 'circuit-breaker-admission',
      liveProbe: false,
      configured: 1,
      available: 0,
      probing: [],
      unavailable: [{
        id: 'codex',
        status: 'unknown',
        reason: 'availability-check-failed',
        cooldownUntil: null,
      }],
    });
  });
});

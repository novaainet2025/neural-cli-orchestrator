import { describe, expect, it } from 'vitest';
import {
  assignmentSnapshotIsReusable,
  mergeProviderAssignmentPolicy,
  resolveProviderAssignment,
  type ProviderAssignmentCandidateInput,
} from './provider-assignment.js';

const REGISTRY_REVISION = 'registry-2026-08-01.1';

function provider(
  id: string,
  overrides: Partial<ProviderAssignmentCandidateInput> = {},
): ProviderAssignmentCandidateInput {
  return {
    id,
    enabled: true,
    capabilities: ['code', 'testing'],
    role: 'Engineer',
    cost: 'paid',
    type: 'cli',
    score: 80,
    availability: {
      healthy: true,
      circuitState: 'closed',
      rateLimited: false,
      capacityUsed: 0,
      capacityTotal: 2,
    },
    ...overrides,
  };
}

describe('provider assignment policy', () => {
  it('merges restrictive fields and puts team preferences first', () => {
    const merged = mergeProviderAssignmentPolicy(
      { requiredCapabilities: ['code'], preferredRoles: ['Engineer'], allowedCosts: ['paid'] },
      { requiredCapabilities: ['testing'], preferredCapabilities: ['review'] },
      { preferredCapabilities: ['verification'], deniedProviderIds: ['retired'], assignmentSize: 2 },
      ['browser'],
    );

    expect(merged.requiredCapabilities).toEqual(['code', 'testing', 'browser']);
    expect(merged.preferredCapabilities).toEqual(['verification', 'review']);
    expect(merged.deniedProviderIds).toEqual(['retired']);
    expect(merged.allowedCosts).toEqual(['paid']);
    expect(merged.assignmentSize).toBe(2);
  });
});

describe('resolveProviderAssignment', () => {
  it('selects only providers enabled and healthy on the current PC', () => {
    const snapshot = resolveProviderAssignment({
      scopeType: 'team',
      scopeId: 'qa',
      registryRevision: REGISTRY_REVISION,
      providers: [
        provider('missing-local-provider', { enabled: false, score: 100 }),
        provider('open-provider', {
          availability: {
            healthy: true,
            circuitState: 'open',
            rateLimited: false,
            capacityUsed: 0,
            capacityTotal: 1,
          },
        }),
        provider('codex'),
      ],
      taskRequiredCapabilities: ['testing'],
      now: new Date('2026-08-01T00:00:00.000Z'),
    });

    expect(snapshot.status).toBe('assigned');
    expect(snapshot.providerIds).toEqual(['codex']);
    expect(snapshot.candidates.find((candidate) => candidate.id === 'missing-local-provider')?.reasons)
      .toContain('not_enabled_by_local_nco');
    expect(snapshot.candidates.find((candidate) => candidate.id === 'open-provider')?.reasons)
      .toContain('circuit_open');
  });

  it('uses provider id as the final deterministic tie-break', () => {
    const input = {
      scopeType: 'organization' as const,
      scopeId: 'acme',
      registryRevision: REGISTRY_REVISION,
      providers: [provider('zeta'), provider('alpha')],
      systemPolicy: { assignmentSize: 2 },
      now: new Date('2026-08-01T00:00:00.000Z'),
    };

    const first = resolveProviderAssignment(input);
    const second = resolveProviderAssignment({ ...input, providers: [...input.providers].reverse() });
    expect(first.providerIds).toEqual(['alpha', 'zeta']);
    expect(second.providerIds).toEqual(first.providerIds);
    expect(second.providerConfigFingerprint).toBe(first.providerConfigFingerprint);
    expect(second.availabilityFingerprint).toBe(first.availabilityFingerprint);
  });

  it('fails closed when required capability or minimum candidate count is unmet', () => {
    const snapshot = resolveProviderAssignment({
      scopeType: 'team',
      scopeId: 'browser-qa',
      registryRevision: REGISTRY_REVISION,
      providers: [provider('codex', { capabilities: ['code'] })],
      companyPolicy: { minimumCandidates: 1 },
      taskRequiredCapabilities: ['browser'],
    });

    expect(snapshot.status).toBe('unassigned');
    expect(snapshot.primaryProviderId).toBeNull();
    expect(snapshot.providerIds).toEqual([]);
    expect(snapshot.candidates[0]?.reasons).toContain('missing_capabilities:browser');
  });

  it('invalidates a cached snapshot when an availability fingerprint changes', () => {
    const base = {
      scopeType: 'organization' as const,
      scopeId: 'acme',
      registryRevision: REGISTRY_REVISION,
      providers: [provider('codex')],
      now: new Date('2026-08-01T00:00:00.000Z'),
    };
    const previous = resolveProviderAssignment(base);
    const changed = resolveProviderAssignment({
      ...base,
      providers: [provider('codex', {
        availability: {
          healthy: true,
          circuitState: 'closed',
          rateLimited: false,
          capacityUsed: 1,
          capacityTotal: 2,
        },
      })],
    });

    expect(assignmentSnapshotIsReusable(previous, changed, new Date('2026-08-01T00:01:00.000Z')))
      .toBe(false);
  });

  it('pins fingerprints and reuse to the registry revision', () => {
    const base = {
      scopeType: 'team' as const,
      scopeId: 'build',
      providers: [provider('codex')],
      now: new Date('2026-08-01T00:00:00.000Z'),
    };
    const previous = resolveProviderAssignment({ ...base, registryRevision: 'registry-1' });
    const changed = resolveProviderAssignment({ ...base, registryRevision: 'registry-2' });

    expect(changed.registryRevision).toBe('registry-2');
    expect(changed.providerConfigFingerprint).not.toBe(previous.providerConfigFingerprint);
    expect(assignmentSnapshotIsReusable(previous, changed, new Date('2026-08-01T00:01:00.000Z')))
      .toBe(false);
  });

  it('rejects an unversioned registry view', () => {
    expect(() => resolveProviderAssignment({
      scopeType: 'team',
      scopeId: 'build',
      registryRevision: '  ',
      providers: [provider('codex')],
    })).toThrow('provider registry revision is required');
  });
});

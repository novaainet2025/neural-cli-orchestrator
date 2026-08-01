import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderAssignmentSnapshot } from '../../core/provider-assignment.js';
import {
  registerProviderAssignmentRoutes,
  type ProviderAssignmentRouteDependencies,
} from './provider-assignments.js';

function snapshot(status: 'assigned' | 'unassigned' = 'assigned'): ProviderAssignmentSnapshot {
  return {
    assignmentId: 'assignment-1',
    scopeType: 'team',
    scopeId: 'team-1',
    registryRevision: 'registry-1',
    status,
    primaryProviderId: status === 'assigned' ? 'codex' : null,
    providerIds: status === 'assigned' ? ['codex'] : [],
    policyFingerprint: 'policy-fingerprint',
    providerConfigFingerprint: 'provider-config-fingerprint',
    availabilityFingerprint: 'availability-fingerprint',
    reason: status === 'assigned' ? 'selected_1_of_1_eligible' : 'eligible_candidates_0_below_minimum_1',
    candidates: [{
      id: 'codex',
      eligible: status === 'assigned',
      score: 80,
      reasons: status === 'assigned' ? ['eligible'] : ['circuit_open'],
      scoreComponents: {
        preferredCapabilities: 0,
        preferredRole: 0,
        localPreference: 0,
        providerScore: 80,
        capacityRatio: 1,
      },
    }],
    createdAt: '2026-08-01T00:00:00.000Z',
    validUntil: '2026-08-01T00:05:00.000Z',
  };
}

function dependencies(
  overrides: Partial<ProviderAssignmentRouteDependencies> = {},
): ProviderAssignmentRouteDependencies {
  return {
    scopeExists: vi.fn(() => true),
    getPolicy: vi.fn(() => null),
    upsertPolicy: vi.fn((scopeType, scopeId, policy) => ({
      scopeType,
      scopeId,
      policy,
      version: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    })),
    getEffectivePolicy: vi.fn(() => ({
      requiredCapabilities: [],
      preferredCapabilities: [],
      preferredRoles: [],
      deniedProviderIds: [],
      allowedCosts: [],
      allowedTypes: [],
      preferLocal: false,
      minimumCandidates: 1,
      assignmentSize: 1,
      fallback: 'strict' as const,
      ttlSeconds: 300,
    })),
    resolveAssignment: vi.fn(() => snapshot()),
    getSnapshot: vi.fn(() => snapshot()),
    listEvents: vi.fn(() => []),
    ...overrides,
  };
}

describe('provider assignment routes', () => {
  it('stores capability policy without accepting a positive provider id', async () => {
    const app = Fastify();
    const deps = dependencies();
    await registerProviderAssignmentRoutes(app, deps);

    const accepted = await app.inject({
      method: 'PUT',
      url: '/api/teams/team-1/provider-policy',
      payload: {
        requiredCapabilities: ['testing'],
        preferredRoles: ['Reviewer'],
        assignmentSize: 2,
      },
    });
    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/teams/team-1/provider-policy',
      payload: { providerId: 'codex' },
    });

    expect(accepted.statusCode).toBe(200);
    expect(deps.upsertPolicy).toHaveBeenCalledWith('team', 'team-1', {
      requiredCapabilities: ['testing'],
      preferredRoles: ['Reviewer'],
      assignmentSize: 2,
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toBe('invalid_provider_assignment_policy');
    await app.close();
  });

  it('returns structured 409 instead of a hidden provider fallback', async () => {
    const app = Fastify();
    const deps = dependencies({ resolveAssignment: vi.fn(() => snapshot('unassigned')) });
    await registerProviderAssignmentRoutes(app, deps);

    const response = await app.inject({
      method: 'GET',
      url: '/api/teams/team-1/provider-assignment?refresh=1&taskCapability=browser',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'provider_assignment_unavailable',
      assignment: {
        status: 'unassigned',
        providerIds: [],
        providerConfigFingerprint: 'provider-config-fingerprint',
        candidates: [{ id: 'codex', reasons: ['circuit_open'] }],
      },
    });
    expect(deps.resolveAssignment).toHaveBeenCalledWith({
      scopeType: 'team',
      scopeId: 'team-1',
      refresh: true,
      taskRequiredCapabilities: ['browser'],
    });
    await app.close();
  });

  it('returns assignment and event receipts by immutable assignment id', async () => {
    const app = Fastify();
    const deps = dependencies({
      listEvents: vi.fn(() => [{
        id: 'event-1',
        assignmentId: 'assignment-1',
        eventType: 'assigned',
        taskId: null,
        fromProviderId: null,
        toProviderId: 'codex',
        reason: 'initial_resolution',
        evidence: { tier: 1 },
        createdAt: '2026-08-01T00:00:00.000Z',
      }]),
    });
    await registerProviderAssignmentRoutes(app, deps);

    const response = await app.inject({
      method: 'GET',
      url: '/api/provider-assignments/assignment-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      assignment: { assignmentId: 'assignment-1', primaryProviderId: 'codex' },
      events: [{ id: 'event-1', toProviderId: 'codex' }],
    });
    await app.close();
  });

  it('uses a non-mutating preview for GET when the runtime provides one', async () => {
    const app = Fastify();
    const previewAssignment = vi.fn(() => snapshot());
    const deps = dependencies({ previewAssignment });
    await registerProviderAssignmentRoutes(app, deps);

    const response = await app.inject({
      method: 'GET',
      url: '/api/teams/team-1/provider-assignment?refresh=1&taskCapability=testing',
    });

    expect(response.statusCode).toBe(200);
    expect(previewAssignment).toHaveBeenCalledWith({
      scopeType: 'team',
      scopeId: 'team-1',
      refresh: true,
      taskRequiredCapabilities: ['testing'],
    });
    expect(deps.resolveAssignment).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 404 before touching policy storage for a missing target', async () => {
    const app = Fastify();
    const deps = dependencies({ scopeExists: vi.fn(() => false) });
    await registerProviderAssignmentRoutes(app, deps);

    const response = await app.inject({
      method: 'GET',
      url: '/api/organizations/missing/provider-policy',
    });

    expect(response.statusCode).toBe(404);
    expect(deps.getPolicy).not.toHaveBeenCalled();
    await app.close();
  });
});

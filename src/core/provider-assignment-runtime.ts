import type Database from 'better-sqlite3';
import { agentManager } from '../agent/agent-manager.js';
import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';
import { getDb } from '../storage/database.js';
import { loadEnabledProviders, type ProviderConfig } from '../utils/config.js';
import { createId } from '../utils/id.js';
import { listActivelyRateLimited } from './rate-limit-state.js';
import {
  assignmentSnapshotIsReusable,
  resolveProviderAssignment,
  type ProviderAssignmentCandidateInput,
  type ProviderAssignmentPolicy,
  type ProviderAssignmentPolicyOverride,
  type ProviderAssignmentScope,
  type ProviderAssignmentSnapshot,
} from './provider-assignment.js';
import {
  ProviderAssignmentStore,
  type ProviderAssignmentEvent,
  type ProviderAssignmentPolicyRecord,
} from './provider-assignment-store.js';
import type { ResolveAssignmentRequest } from '../server/routes/provider-assignments.js';

const ACTIVE_TASK_STATUSES = [
  'pending',
  'assigned',
  'running',
  'streaming',
  'reviewing',
] as const;

export interface ProviderAssignmentRuntimeDependencies {
  database?: Database.Database;
  providers?: () => ProviderConfig[];
  enabledProviderIds?: () => string[];
  circuitAvailability?: (providerId: string) => {
    available: boolean;
    circuitState: 'closed' | 'open' | 'half-open';
  };
  now?: () => Date;
  createAssignmentId?: () => string;
}

export class ProviderAssignmentRuntime {
  private readonly database: Database.Database;
  private readonly store: ProviderAssignmentStore;
  private readonly providers: () => ProviderConfig[];
  private readonly enabledProviderIds: () => string[];
  private readonly circuitAvailability: NonNullable<
    ProviderAssignmentRuntimeDependencies['circuitAvailability']
  >;
  private readonly now: () => Date;
  private readonly createAssignmentId: () => string;

  constructor(dependencies: ProviderAssignmentRuntimeDependencies = {}) {
    this.database = dependencies.database ?? getDb();
    this.store = new ProviderAssignmentStore(this.database);
    this.providers = dependencies.providers ?? loadEnabledProviders;
    this.enabledProviderIds = dependencies.enabledProviderIds
      ?? (() => agentManager.listEnabledIds());
    this.circuitAvailability = dependencies.circuitAvailability
      ?? ((providerId) => circuitBreakerRegistry.getAvailability(providerId));
    this.now = dependencies.now ?? (() => new Date());
    this.createAssignmentId = dependencies.createAssignmentId ?? (() => createId('pas'));
  }

  scopeExists(scopeType: ProviderAssignmentScope, scopeId: string): boolean {
    const table = scopeType === 'organization' ? 'organizations' : 'teams';
    return Boolean(this.database.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(scopeId));
  }

  getPolicy(
    scopeType: ProviderAssignmentScope,
    scopeId: string,
  ): ProviderAssignmentPolicyRecord | null {
    return this.store.getPolicy(scopeType, scopeId);
  }

  upsertPolicy(
    scopeType: ProviderAssignmentScope,
    scopeId: string,
    policy: ProviderAssignmentPolicyOverride,
  ): ProviderAssignmentPolicyRecord {
    return this.store.upsertPolicy(scopeType, scopeId, policy);
  }

  getEffectivePolicy(
    scopeType: ProviderAssignmentScope,
    scopeId: string,
    taskRequiredCapabilities: readonly string[] = [],
  ): ProviderAssignmentPolicy {
    return this.store.getEffectivePolicy(scopeType, scopeId, {}, taskRequiredCapabilities);
  }

  getSnapshot(assignmentId: string): ProviderAssignmentSnapshot | null {
    return this.store.getSnapshot(assignmentId);
  }

  listEvents(assignmentId: string): ProviderAssignmentEvent[] {
    return this.store.listEvents(assignmentId);
  }

  private activeTaskCounts(): { readable: boolean; counts: Map<string, number> } {
    try {
      const placeholders = ACTIVE_TASK_STATUSES.map(() => '?').join(', ');
      const rows = this.database.prepare(`
        SELECT assigned_to AS provider_id, COUNT(*) AS active_count
        FROM tasks
        WHERE assigned_to IS NOT NULL AND status IN (${placeholders})
        GROUP BY assigned_to
      `).all(...ACTIVE_TASK_STATUSES) as Array<{ provider_id: string; active_count: number }>;
      return {
        readable: true,
        counts: new Map(rows.map((row) => [row.provider_id, row.active_count])),
      };
    } catch {
      return { readable: false, counts: new Map() };
    }
  }

  buildCandidates(): ProviderAssignmentCandidateInput[] {
    const enabledIds = new Set(this.enabledProviderIds());
    let rateLimitReadable = true;
    let limited = new Set<string>();
    try {
      limited = listActivelyRateLimited(this.database);
    } catch {
      rateLimitReadable = false;
    }
    const active = this.activeTaskCounts();

    return this.providers()
      .map((provider): ProviderAssignmentCandidateInput => {
        let circuitReadable = true;
        let circuitState: ProviderAssignmentCandidateInput['availability']['circuitState'] = 'unknown';
        try {
          circuitState = this.circuitAvailability(provider.id).circuitState;
        } catch {
          circuitReadable = false;
        }
        const capacityTotal = Math.max(1, Math.floor(provider.concurrency || 1));
        const capacityUsed = active.readable
          ? active.counts.get(provider.id) ?? 0
          : capacityTotal;
        const enabled = provider.enabled && enabledIds.has(provider.id);
        return {
          id: provider.id,
          enabled,
          capabilities: provider.capabilities,
          role: provider.role,
          cost: provider.cost,
          type: provider.type,
          score: provider.score,
          availability: {
            // Registry membership is the synchronous boot-time health boundary.
            // If any admission state cannot be read, fail closed for this snapshot.
            healthy: enabled && circuitReadable && rateLimitReadable && active.readable,
            circuitState,
            rateLimited: !rateLimitReadable || limited.has(provider.id),
            capacityUsed,
            capacityTotal,
          },
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  resolveAssignment(request: ResolveAssignmentRequest): ProviderAssignmentSnapshot {
    const now = this.now();
    const providers = this.buildCandidates();
    const effectivePolicy = this.getEffectivePolicy(
      request.scopeType,
      request.scopeId,
      request.taskRequiredCapabilities,
    );
    const proposed = resolveProviderAssignment({
      scopeType: request.scopeType,
      scopeId: request.scopeId,
      providers,
      systemPolicy: effectivePolicy,
      assignmentId: this.createAssignmentId(),
      now,
    });
    const previous = this.store.getLatestSnapshot(request.scopeType, request.scopeId);
    if (!request.refresh && previous && assignmentSnapshotIsReusable(previous, proposed, now)) {
      return previous;
    }

    this.store.appendSnapshot(proposed);
    this.store.appendEvent({
      assignmentId: proposed.assignmentId,
      eventType: previous ? 'reselected' : proposed.status === 'assigned' ? 'assigned' : 'unassigned',
      fromProviderId: previous?.primaryProviderId ?? null,
      toProviderId: proposed.primaryProviderId,
      reason: proposed.reason,
      evidence: {
        previousAssignmentId: previous?.assignmentId ?? null,
        policyFingerprint: proposed.policyFingerprint,
        providerConfigFingerprint: proposed.providerConfigFingerprint,
        availabilityFingerprint: proposed.availabilityFingerprint,
        taskRequiredCapabilities: request.taskRequiredCapabilities,
      },
      createdAt: proposed.createdAt,
    });
    return proposed;
  }
}

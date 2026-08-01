import type Database from 'better-sqlite3';
import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';
import { getDb } from '../storage/database.js';
import { loadEnabledProviders, type ProviderConfig } from '../utils/config.js';
import { createId } from '../utils/id.js';
import { listActivelyRateLimited } from './rate-limit-state.js';
import {
  assignmentSnapshotIsReusable,
  fingerprint,
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
  'assigned',
  'running',
  'streaming',
  'reviewing',
] as const;

/** Atomic, PC-effective provider registry view used for one assignment decision. */
export interface ProviderAssignmentRegistryView {
  revision: string;
  providers: readonly ProviderConfig[];
}

export interface ProviderAssignmentRuntimeDependencies {
  database?: Database.Database;
  registryView?: () => ProviderAssignmentRegistryView;
  circuitAvailability?: (providerId: string) => {
    available: boolean;
    circuitState: 'closed' | 'open' | 'half-open';
  };
  now?: () => Date;
  createAssignmentId?: () => string;
}

let defaultRegistryView: () => ProviderAssignmentRegistryView = legacyProviderAssignmentRegistryView;

/** Bind every company/team assignment runtime to the committed Registry v2 view. */
export function setDefaultProviderAssignmentRegistryView(
  registryView: () => ProviderAssignmentRegistryView,
): void {
  defaultRegistryView = registryView;
}

export class ProviderAssignmentRuntime {
  private readonly database: Database.Database;
  private readonly store: ProviderAssignmentStore;
  private readonly registryView: () => ProviderAssignmentRegistryView;
  private readonly circuitAvailability: NonNullable<
    ProviderAssignmentRuntimeDependencies['circuitAvailability']
  >;
  private readonly now: () => Date;
  private readonly createAssignmentId: () => string;

  constructor(dependencies: ProviderAssignmentRuntimeDependencies = {}) {
    this.database = dependencies.database ?? getDb();
    this.store = new ProviderAssignmentStore(this.database);
    this.registryView = dependencies.registryView ?? (() => defaultRegistryView());
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

  buildCandidates(
    registryView: ProviderAssignmentRegistryView = this.readRegistryView(),
  ): ProviderAssignmentCandidateInput[] {
    let rateLimitReadable = true;
    let limited = new Set<string>();
    try {
      limited = listActivelyRateLimited(this.database);
    } catch {
      rateLimitReadable = false;
    }
    const active = this.activeTaskCounts();

    return registryView.providers
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
        const enabled = provider.enabled;
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

  private readRegistryView(): ProviderAssignmentRegistryView {
    const view = this.registryView();
    if (!view.revision?.trim()) {
      throw new Error('provider registry view is missing a revision');
    }
    return view;
  }

  private proposeAssignment(request: ResolveAssignmentRequest): {
    now: Date;
    proposed: ProviderAssignmentSnapshot;
    previous: ProviderAssignmentSnapshot | null;
  } {
    const now = this.now();
    // Read exactly one registry view so provider membership and revision cannot
    // drift within a decision while a hot reload swaps the live snapshot.
    const registryView = this.readRegistryView();
    const providers = this.buildCandidates(registryView);
    const effectivePolicy = this.getEffectivePolicy(
      request.scopeType,
      request.scopeId,
      request.taskRequiredCapabilities,
    );
    const proposed = resolveProviderAssignment({
      scopeType: request.scopeType,
      scopeId: request.scopeId,
      registryRevision: registryView.revision,
      providers,
      systemPolicy: effectivePolicy,
      assignmentId: this.createAssignmentId(),
      now,
    });
    const previous = this.store.getLatestSnapshot(request.scopeType, request.scopeId);
    return { now, proposed, previous };
  }

  previewAssignment(request: ResolveAssignmentRequest): ProviderAssignmentSnapshot {
    const { now, proposed, previous } = this.proposeAssignment(request);
    if (!request.refresh && previous && assignmentSnapshotIsReusable(previous, proposed, now)) {
      return previous;
    }
    return proposed;
  }

  resolveAssignment(request: ResolveAssignmentRequest): ProviderAssignmentSnapshot {
    const { now, proposed, previous } = this.proposeAssignment(request);
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
        registryRevision: proposed.registryRevision,
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

/**
 * Compatibility adapter until the revisioned hot-reload registry is wired at
 * bootstrap. It still returns one coherent view and never consults AgentManager.
 */
export function legacyProviderAssignmentRegistryView(): ProviderAssignmentRegistryView {
  const providers = loadEnabledProviders();
  const publicAssignmentConfig = providers.map((provider) => ({
    id: provider.id,
    enabled: provider.enabled,
    type: provider.type,
    role: provider.role,
    score: provider.score,
    concurrency: provider.concurrency,
    cost: provider.cost,
    capabilities: [...provider.capabilities].sort(),
  }));
  return {
    revision: `legacy-${fingerprint(publicAssignmentConfig)}`,
    providers,
  };
}

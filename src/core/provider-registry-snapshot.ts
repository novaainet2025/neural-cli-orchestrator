import { createHash } from 'node:crypto';
import type { ProviderConfig } from '../utils/config.js';

/**
 * Public, data-only provider contract consumed by Nova and other harnesses.
 *
 * Deliberately excluded: command/args, process env, health-check internals,
 * personas and permission maps. A registry update must never become a remote
 * arbitrary-command contract or leak a configured secret value.
 */
export interface ProviderRegistryManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  enabled: boolean;
  type: ProviderConfig['type'];
  role: string;
  score: number;
  model: string | null;
  models: Array<{
    id: string;
    enabled: boolean;
    default: boolean;
    aliases: string[];
    capabilities: string[];
    tier: string;
    reasoningStrength: number;
    costClass: string;
    latencyClass: string;
    contextWindow: number | null;
    availability: string;
  }>;
  endpoint?: string;
  auth?: { kind: 'environment-reference'; ref: string };
  capabilities: string[];
  runtime: {
    executor: string;
    adapter: string;
    profile?: string;
    /** True only when the current AgentManager generation has this provider. */
    loaded: boolean;
  };
  routing?: {
    tier: string;
    departments: string[];
    taskTypes: string[];
    priority: number;
    discussionEligible: boolean;
    discussionPriority: number;
  };
}

export interface ProviderRegistrySnapshot {
  revision: string;
  generatedAt: string;
  providers: ProviderRegistryManifest[];
}

export type ProviderRegistryChangeType = 'added' | 'updated' | 'disabled' | 'removed';

export interface ProviderRegistryChange {
  type: ProviderRegistryChangeType;
  providerId: string;
  manifest?: ProviderRegistryManifest;
}

export interface ProviderRegistryChangedEvent {
  type: 'provider.registry.changed';
  payload: {
    revision: string;
    changes: ProviderRegistryChange[];
  };
  [key: string]: unknown;
}

export interface ProviderRegistryCommittedEvent {
  type: 'provider.registry.committed';
  payload: {
    revision: string;
    changes: ProviderRegistryChange[];
  };
  [key: string]: unknown;
}

export interface ProviderRegistryReloadFailedEvent {
  type: 'provider.registry.reload_failed';
  payload: {
    activeRevision: string | null;
    reason: 'load_failed' | 'runtime_reconcile_failed';
  };
  [key: string]: unknown;
}

export type ProviderRegistryEvent =
  | ProviderRegistryChangedEvent
  | ProviderRegistryCommittedEvent
  | ProviderRegistryReloadFailedEvent;

export interface ProviderRegistryRuntimeView {
  revision: string;
  providers: readonly ProviderConfig[];
}

export interface ProviderRegistryRefreshResult {
  changed: boolean;
  snapshot: ProviderRegistrySnapshot;
  changes: ProviderRegistryChange[];
}

export interface ProviderRegistrySnapshotOptions {
  loadProviders: () => ProviderConfig[];
  listRuntimeProviderIds: () => Iterable<string>;
  publish: (event: ProviderRegistryEvent) => Promise<unknown>;
  /** Reconcile every runtime consumer before the public revision becomes visible. */
  reconcileRuntime?: (view: ProviderRegistryRuntimeView) => Promise<void>;
  pollIntervalMs?: number;
  now?: () => Date;
  onPollError?: (error: unknown) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MIN_POLL_INTERVAL_MS = 250;
const AUTH_REFERENCE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function sortedUnique(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))].sort();
}

function publicEndpoint(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    // Userinfo and query parameters are common accidental secret carriers.
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    // A non-URL endpoint is not safe or useful to a remote registry client.
    return undefined;
  }
}

function publicModelCatalog(provider: ProviderConfig): ProviderRegistryManifest['models'] {
  const catalog = new Map<string, ProviderRegistryManifest['models'][number]>();
  for (const model of provider.models ?? []) {
    const id = model.id.trim();
    if (!id || catalog.has(id)) continue;
    catalog.set(id, {
      id,
      enabled: model.enabled !== false,
      default: model.default === true,
      aliases: sortedUnique(model.aliases),
      capabilities: sortedUnique(model.capabilities),
      tier: model.tier ?? 'balanced',
      reasoningStrength: model.reasoningStrength ?? 3,
      costClass: model.costClass ?? 'standard',
      latencyClass: model.latencyClass ?? 'standard',
      contextWindow: model.contextWindow ?? null,
      availability: model.enabled === false ? 'unavailable' : model.availability ?? 'available',
    });
  }

  // The current NCO catalog declares provider.model but no provider.models for
  // every built-in provider. Preserve that selected model as an executable,
  // default catalog entry so a dynamic client never receives an empty picker.
  const configuredModel = provider.model?.trim();
  if (catalog.size === 0 && configuredModel) {
    catalog.set(configuredModel, {
      id: configuredModel,
      enabled: true,
      default: true,
      aliases: [],
      capabilities: sortedUnique(provider.capabilities),
      tier: 'balanced',
      reasoningStrength: 3,
      costClass: 'standard',
      latencyClass: 'standard',
      contextWindow: null,
      availability: 'available',
    });
  }

  // freeModels is an additional discovery hint, not a separate execution
  // contract. Merge it as enabled non-default catalog data and de-duplicate by
  // exact model id; explicit model declarations always win.
  for (const rawId of provider.freeModels ?? []) {
    const id = rawId.trim();
    if (!id || catalog.has(id)) continue;
    catalog.set(id, {
      id,
      enabled: true,
      default: false,
      aliases: [],
      capabilities: sortedUnique(provider.capabilities),
      tier: 'balanced',
      reasoningStrength: 3,
      costClass: provider.cost === 'free' ? 'minimal' : 'standard',
      latencyClass: 'standard',
      contextWindow: null,
      availability: 'available',
    });
  }

  return [...catalog.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Convert the internal execution config into a safe, deterministic manifest. */
export function toProviderRegistryManifest(
  provider: ProviderConfig,
  runtimeProviderIds: ReadonlySet<string>,
): ProviderRegistryManifest {
  const runtime = provider.runtime;
  const routing = provider.routing;
  const endpoint = publicEndpoint(provider.endpoint);
  const authRef = provider.apiKeyRef && AUTH_REFERENCE_PATTERN.test(provider.apiKeyRef)
    ? provider.apiKeyRef
    : undefined;

  return {
    schemaVersion: 1,
    id: provider.id,
    name: provider.name,
    enabled: provider.enabled,
    type: provider.type,
    role: provider.role,
    score: provider.score,
    model: provider.model,
    models: publicModelCatalog(provider),
    ...(endpoint ? { endpoint } : {}),
    ...(authRef ? { auth: { kind: 'environment-reference' as const, ref: authRef } } : {}),
    capabilities: sortedUnique(provider.capabilities),
    runtime: {
      executor: runtime?.executor ?? 'unknown',
      adapter: runtime?.adapter ?? 'unknown',
      ...(runtime?.profile ? { profile: runtime.profile } : {}),
      loaded: runtimeProviderIds.has(provider.id),
    },
    ...(routing ? {
      routing: {
        tier: routing.tier,
        departments: sortedUnique(routing.departments),
        taskTypes: sortedUnique(routing.taskTypes),
        priority: routing.priority,
        discussionEligible: routing.discussionEligible,
        discussionPriority: routing.discussionPriority,
      },
    } : {}),
  };
}

function snapshotRevision(providers: readonly ProviderRegistryManifest[]): string {
  const content = JSON.stringify(providers);
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function manifestById(
  providers: readonly ProviderRegistryManifest[],
): Map<string, ProviderRegistryManifest> {
  return new Map(providers.map(provider => [provider.id, provider]));
}

function manifestsEqual(
  left: ProviderRegistryManifest,
  right: ProviderRegistryManifest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Compute a lifecycle diff between two complete snapshots.
 * A true -> false enabled transition has the stronger `disabled` signal;
 * re-enabling or any other mutation is `updated`.
 */
export function diffProviderRegistry(
  previous: readonly ProviderRegistryManifest[],
  next: readonly ProviderRegistryManifest[],
): ProviderRegistryChange[] {
  const before = manifestById(previous);
  const after = manifestById(next);
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();

  return ids.flatMap((providerId): ProviderRegistryChange[] => {
    const oldManifest = before.get(providerId);
    const manifest = after.get(providerId);
    if (!oldManifest && manifest) return [{ type: 'added', providerId, manifest }];
    if (oldManifest && !manifest) return [{ type: 'removed', providerId }];
    if (!oldManifest || !manifest || manifestsEqual(oldManifest, manifest)) return [];
    return [{
      type: oldManifest.enabled && !manifest.enabled ? 'disabled' : 'updated',
      providerId,
      manifest,
    }];
  });
}

/**
 * Last-known-good registry with revisioned polling and replay-safe snapshots.
 * Event loss is recoverable by fetching the complete snapshot and comparing
 * its content revision.
 */
export class ProviderRegistrySnapshotStore {
  private snapshot: ProviderRegistrySnapshot | null = null;
  private runtimeView: ProviderRegistryRuntimeView | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: ProviderRegistrySnapshotOptions) {}

  refresh(): Promise<ProviderRegistryRefreshResult> {
    let resolveResult!: (result: ProviderRegistryRefreshResult) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<ProviderRegistryRefreshResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.refreshTail = this.refreshTail
      .then(async () => {
        try {
          resolveResult(await this.refreshOnce());
        } catch (error) {
          rejectResult(error);
        }
      })
      .catch(() => {
        // The per-call promise carries the error. Keep the serialization tail
        // fulfilled so one malformed transient file does not stop recovery.
      });
    return result;
  }

  getSnapshot(): ProviderRegistrySnapshot | null {
    return this.snapshot;
  }

  /** Provider assignments read membership and revision from this one immutable view. */
  getRuntimeView(): ProviderRegistryRuntimeView | null {
    return this.runtimeView;
  }

  start(): void {
    if (this.timer) return;
    const requested = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const interval = Number.isFinite(requested)
      ? Math.max(MIN_POLL_INTERVAL_MS, Math.trunc(requested))
      : DEFAULT_POLL_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.refresh().catch(error => this.options.onPollError?.(error));
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async refreshOnce(): Promise<ProviderRegistryRefreshResult> {
    let configs: ProviderConfig[];
    try {
      configs = this.options.loadProviders();
    } catch (error) {
      await this.publishReloadFailure('load_failed');
      throw error;
    }

    const desiredRuntimeIds = this.options.reconcileRuntime
      ? new Set(configs.filter(provider => provider.enabled !== false).map(provider => provider.id))
      : new Set(this.options.listRuntimeProviderIds());
    const desiredProviders = configs
      .map(provider => toProviderRegistryManifest(provider, desiredRuntimeIds))
      .sort((left, right) => left.id.localeCompare(right.id));
    const revision = snapshotRevision(desiredProviders);

    if (this.snapshot?.revision === revision) {
      return { changed: false, snapshot: this.snapshot, changes: [] };
    }

    if (this.options.reconcileRuntime) {
      try {
        await this.options.reconcileRuntime({ revision, providers: configs });
        const actualRuntimeIds = new Set(this.options.listRuntimeProviderIds());
        if (
          actualRuntimeIds.size !== desiredRuntimeIds.size
          || [...desiredRuntimeIds].some(providerId => !actualRuntimeIds.has(providerId))
        ) {
          throw new Error('provider runtime did not converge to the requested registry revision');
        }
      } catch (error) {
        await this.publishReloadFailure('runtime_reconcile_failed');
        throw error;
      }
    }

    const previous = this.snapshot;
    const runtimeProviderIds = new Set(this.options.listRuntimeProviderIds());
    const providers = configs
      .map(provider => toProviderRegistryManifest(provider, runtimeProviderIds))
      .sort((left, right) => left.id.localeCompare(right.id));
    const committedRevision = snapshotRevision(providers);
    if (committedRevision !== revision) {
      await this.publishReloadFailure('runtime_reconcile_failed');
      throw new Error('provider runtime view changed while committing registry revision');
    }
    const changes = diffProviderRegistry(previous?.providers ?? [], providers);
    const snapshot: ProviderRegistrySnapshot = {
      revision: committedRevision,
      generatedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      providers,
    };
    // These references are swapped synchronously after all runtime consumers
    // accepted the same view. Polling clients can recover an event gap from it.
    this.runtimeView = Object.freeze({
      revision: committedRevision,
      providers: Object.freeze([...configs]),
    });
    this.snapshot = snapshot;
    if (previous && changes.length > 0) {
      await this.options.publish({
        type: 'provider.registry.committed',
        payload: { revision: committedRevision, changes },
      });
      // Compatibility event for clients deployed before Registry v2.
      await this.options.publish({
        type: 'provider.registry.changed',
        payload: { revision: committedRevision, changes },
      });
    }
    return { changed: true, snapshot, changes };
  }

  private async publishReloadFailure(
    reason: ProviderRegistryReloadFailedEvent['payload']['reason'],
  ): Promise<void> {
    try {
      await this.options.publish({
        type: 'provider.registry.reload_failed',
        payload: {
          activeRevision: this.snapshot?.revision ?? null,
          reason,
        },
      });
    } catch {
      // The original load/reconcile failure is authoritative. Polling and the
      // retained LKG snapshot remain available even if event delivery fails.
    }
  }
}

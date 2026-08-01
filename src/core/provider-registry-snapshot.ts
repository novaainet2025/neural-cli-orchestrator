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

/** Compatibility projection for older Nova clients. It is data-only by design. */
export interface LegacyProviderCatalogProjection {
  id: string;
  ai: string;
  name: string;
  enabled: boolean;
  type: ProviderRegistryManifest['type'];
  role: string;
  score: number;
  model?: string;
  models: string[];
  capabilities: string[];
  runtime: ProviderRegistryManifest['runtime'];
  routing?: ProviderRegistryManifest['routing'];
}

/** Never spread internal ProviderConfig into a compatibility HTTP response. */
export function toLegacyProviderCatalogProjection(
  manifest: ProviderRegistryManifest,
): LegacyProviderCatalogProjection {
  return {
    id: manifest.id,
    ai: manifest.id,
    name: manifest.name,
    enabled: manifest.enabled,
    type: manifest.type,
    role: manifest.role,
    score: manifest.score,
    ...(manifest.model ? { model: manifest.model } : {}),
    models: manifest.models.filter(model => model.enabled).map(model => model.id),
    capabilities: [...manifest.capabilities],
    runtime: { ...manifest.runtime },
    ...(manifest.routing ? { routing: { ...manifest.routing } } : {}),
  };
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
    if (url.username || url.password || url.search || url.hash) {
      // Do not try to sanitize a credential-bearing execution URL into a
      // seemingly safe remote contract. Omit it so clients delegate to NCO.
      return undefined;
    }
    const normalizedPath = url.pathname.replace(/\/+$/, '') || '/';
    if (!['/', '/v1', '/api', '/api/v1'].includes(normalizedPath)) return undefined;
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
      // Keep older Registry clients safe: clients deployed before the
      // `availability` field existed only understand `enabled`. An explicitly
      // unavailable model therefore has to be non-selectable in both fields.
      enabled: model.enabled !== false && model.availability !== 'unavailable',
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

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

function canonicalFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function snapshotRevision(
  providers: readonly ProviderRegistryManifest[],
  internalRuntimeFingerprint: string,
): string {
  // The final public revision commits to both safe discovery data and the
  // complete execution generation. Only this domain-separated outer hash is
  // exposed; neither canonical ProviderConfig data nor its intermediate hash
  // is copied into snapshots or events.
  const content = JSON.stringify({
    domain: 'nco.provider-registry.revision.v2',
    providers,
    internalRuntimeFingerprint,
  });
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** Internal-only execution fingerprint. Never return this hash or its inputs over HTTP. */
function runtimeFingerprint(providers: readonly ProviderConfig[]): string {
  const ordered = [...providers].sort((left, right) => left.id.localeCompare(right.id));
  return canonicalFingerprint(ordered);
}

/** Per-provider hashes exist only to produce safe lifecycle diffs. */
function runtimeFingerprintsByProvider(
  providers: readonly ProviderConfig[],
): Map<string, string> {
  return new Map(providers.map(provider => [provider.id, canonicalFingerprint(provider)]));
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

function mergeRuntimeConfigChanges(
  publicChanges: readonly ProviderRegistryChange[],
  nextManifests: readonly ProviderRegistryManifest[],
  previousFingerprints: ReadonlyMap<string, string> | null,
  nextFingerprints: ReadonlyMap<string, string>,
): ProviderRegistryChange[] {
  if (!previousFingerprints) return [...publicChanges];
  const changes = new Map(publicChanges.map(change => [change.providerId, change]));
  const manifests = manifestById(nextManifests);

  for (const [providerId, fingerprint] of nextFingerprints) {
    const previous = previousFingerprints.get(providerId);
    const manifest = manifests.get(providerId);
    if (previous !== undefined && previous !== fingerprint && manifest && !changes.has(providerId)) {
      // The public projection is intentionally unchanged, but consumers still
      // need a lifecycle signal that this provider now belongs to a new
      // execution generation. Reusing the safe manifest avoids secret leaks.
      changes.set(providerId, { type: 'updated', providerId, manifest });
    }
  }

  return [...changes.values()].sort((left, right) => left.providerId.localeCompare(right.providerId));
}

/**
 * Last-known-good registry with revisioned polling and replay-safe snapshots.
 * Event loss is recoverable by fetching the complete snapshot and comparing
 * its content revision.
 */
export class ProviderRegistrySnapshotStore {
  private snapshot: ProviderRegistrySnapshot | null = null;
  private runtimeView: ProviderRegistryRuntimeView | null = null;
  private committedRuntimeFingerprint: string | null = null;
  private committedProviderFingerprints: ReadonlyMap<string, string> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight: Promise<ProviderRegistryRefreshResult> | null = null;
  private refreshRequested = false;

  constructor(private readonly options: ProviderRegistrySnapshotOptions) {}

  refresh(): Promise<ProviderRegistryRefreshResult> {
    if (this.refreshInFlight) {
      this.refreshRequested = true;
      return this.refreshInFlight;
    }
    this.refreshInFlight = (async () => {
      let result: ProviderRegistryRefreshResult;
      do {
        this.refreshRequested = false;
        result = await this.refreshOnce();
      } while (this.refreshRequested);
      return result;
    })().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
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
    const desiredRuntimeFingerprint = runtimeFingerprint(configs);
    const revision = snapshotRevision(desiredProviders, desiredRuntimeFingerprint);

    if (
      this.snapshot?.revision === revision
      && this.committedRuntimeFingerprint === desiredRuntimeFingerprint
    ) {
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
    const committedRuntimeFingerprint = runtimeFingerprint(configs);
    const committedRevision = snapshotRevision(providers, committedRuntimeFingerprint);
    if (
      committedRevision !== revision
      || committedRuntimeFingerprint !== desiredRuntimeFingerprint
    ) {
      await this.publishReloadFailure('runtime_reconcile_failed');
      throw new Error('provider runtime view changed while committing registry revision');
    }
    const committedProviderFingerprints = runtimeFingerprintsByProvider(configs);
    const changes = mergeRuntimeConfigChanges(
      diffProviderRegistry(previous?.providers ?? [], providers),
      providers,
      this.committedProviderFingerprints,
      committedProviderFingerprints,
    );
    const snapshot: ProviderRegistrySnapshot = previous?.revision === committedRevision
      ? previous
      : {
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
    this.committedRuntimeFingerprint = committedRuntimeFingerprint;
    this.committedProviderFingerprints = committedProviderFingerprints;
    this.snapshot = snapshot;
    if (previous && previous.revision !== committedRevision) {
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

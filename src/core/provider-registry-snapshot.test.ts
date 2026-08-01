import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../utils/config.js';
import {
  ProviderRegistrySnapshotStore,
  diffProviderRegistry,
  toProviderRegistryManifest,
  type ProviderRegistryEvent,
} from './provider-registry-snapshot.js';

function provider(
  id: string,
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id,
    name: id,
    enabled: true,
    type: 'api',
    role: 'worker',
    score: 70,
    model: `${id}-model`,
    models: [{ id: `${id}-model`, default: true, aliases: ['z', 'a'] }],
    command: 'must-not-leak',
    args: ['--api-key', 'must-not-leak'],
    endpoint: 'https://user:password@example.test/v1?api_key=must-not-leak',
    apiKeyRef: 'PROVIDER_API_KEY',
    env: { PROVIDER_API_KEY: 'must-not-leak' },
    concurrency: 1,
    rateLimitRpm: 60,
    cost: 'free',
    capabilities: ['testing', 'code', 'testing'],
    permissions: { canWrite: true },
    persona: { systemPrompt: 'secret internal prompt', tone: 'direct', style: 'brief' },
    healthCheck: { url: 'https://secret.test/?token=must-not-leak' },
    runtime: { executor: 'openai-api', adapter: 'generic' },
    routing: {
      tier: 'worker',
      departments: ['quality', 'execution'],
      taskTypes: ['verify', 'code'],
      priority: 50,
      discussionEligible: true,
      discussionPriority: 75,
    },
    ...overrides,
  };
}

function store(
  loadProviders: () => ProviderConfig[],
  publish = vi.fn<(event: ProviderRegistryEvent) => Promise<void>>(async () => {}),
) {
  let now = 0;
  return {
    publish,
    registry: new ProviderRegistrySnapshotStore({
      loadProviders,
      listRuntimeProviderIds: () => ['alpha'],
      publish,
      now: () => new Date(++now * 1_000),
    }),
  };
}

describe('ProviderRegistrySnapshotStore', () => {
  it('projects a deterministic manifest without commands or secret values', () => {
    const manifest = toProviderRegistryManifest(provider('alpha'), new Set(['alpha']));
    const serialized = JSON.stringify(manifest);

    expect(manifest.endpoint).toBe('https://example.test/v1');
    expect(manifest.auth).toEqual({ kind: 'environment-reference', ref: 'PROVIDER_API_KEY' });
    expect(manifest.capabilities).toEqual(['code', 'testing']);
    expect(manifest.models[0]?.aliases).toEqual(['a', 'z']);
    expect(manifest.models[0]).toMatchObject({
      tier: 'balanced',
      reasoningStrength: 3,
      costClass: 'standard',
      latencyClass: 'standard',
      contextWindow: null,
      availability: 'available',
    });
    expect(manifest.runtime.loaded).toBe(true);
    expect(manifest.routing).toMatchObject({
      discussionEligible: true,
      discussionPriority: 75,
    });
    expect(serialized).not.toContain('must-not-leak');
    expect(serialized).not.toContain('secret internal prompt');
    expect(serialized).not.toContain('command');
    expect(serialized).not.toContain('healthCheck');
  });

  it('materializes provider.model and de-duplicated freeModels when models is absent', () => {
    const manifest = toProviderRegistryManifest(provider('alpha', {
      models: undefined,
      freeModels: ['free-b', 'alpha-model', 'free-a', 'free-a', '  '],
    }), new Set(['alpha']));

    expect(manifest.models).toEqual([
      {
        id: 'alpha-model',
        enabled: true,
        default: true,
        aliases: [],
        capabilities: ['code', 'testing'],
        tier: 'balanced',
        reasoningStrength: 3,
        costClass: 'standard',
        latencyClass: 'standard',
        contextWindow: null,
        availability: 'available',
      },
      {
        id: 'free-a',
        enabled: true,
        default: false,
        aliases: [],
        capabilities: ['code', 'testing'],
        tier: 'balanced',
        reasoningStrength: 3,
        costClass: 'minimal',
        latencyClass: 'standard',
        contextWindow: null,
        availability: 'available',
      },
      {
        id: 'free-b',
        enabled: true,
        default: false,
        aliases: [],
        capabilities: ['code', 'testing'],
        tier: 'balanced',
        reasoningStrength: 3,
        costClass: 'minimal',
        latencyClass: 'standard',
        contextWindow: null,
        availability: 'available',
      },
    ]);
  });

  it('marks unavailable models disabled for pre-availability Registry clients', () => {
    const manifest = toProviderRegistryManifest(provider('alpha', {
      model: 'available-model',
      models: [
        { id: 'available-model', default: true, availability: 'available' },
        { id: 'degraded-model', availability: 'degraded' },
        { id: 'offline-model', availability: 'unavailable' },
      ],
    }), new Set(['alpha']));

    expect(manifest.models.map(model => ({
      id: model.id,
      enabled: model.enabled,
      availability: model.availability,
    }))).toEqual([
      { id: 'available-model', enabled: true, availability: 'available' },
      { id: 'degraded-model', enabled: true, availability: 'degraded' },
      { id: 'offline-model', enabled: false, availability: 'unavailable' },
    ]);
  });

  it('keeps revision and generatedAt stable for semantically identical refreshes', async () => {
    let providers = [provider('beta'), provider('alpha')];
    const { registry, publish } = store(() => providers);

    const first = await registry.refresh();
    providers = [provider('alpha'), provider('beta')];
    const second = await registry.refresh();

    expect(first.snapshot.providers.map(item => item.id)).toEqual(['alpha', 'beta']);
    expect(second.changed).toBe(false);
    expect(second.snapshot.revision).toBe(first.snapshot.revision);
    expect(second.snapshot.generatedAt).toBe(first.snapshot.generatedAt);
    expect(publish).not.toHaveBeenCalled();

    const independent = store(() => [provider('beta'), provider('alpha')]);
    expect((await independent.registry.refresh()).snapshot.revision).toBe(first.snapshot.revision);
  });

  it('emits exact added, disabled, updated and removed lifecycle diffs', async () => {
    let providers = [provider('alpha')];
    const { registry, publish } = store(() => providers);
    await registry.refresh();

    providers = [provider('alpha', { enabled: false }), provider('beta')];
    const changed = await registry.refresh();
    expect(changed.changes.map(change => [change.type, change.providerId])).toEqual([
      ['disabled', 'alpha'],
      ['added', 'beta'],
    ]);
    expect(publish).toHaveBeenCalledWith({
      type: 'provider.registry.committed',
      payload: {
        revision: changed.snapshot.revision,
        changes: changed.changes,
      },
    });
    expect(publish).toHaveBeenLastCalledWith({
      type: 'provider.registry.changed',
      payload: {
        revision: changed.snapshot.revision,
        changes: changed.changes,
      },
    });

    providers = [provider('alpha', { enabled: true, score: 99 })];
    const next = await registry.refresh();
    expect(next.changes.map(change => [change.type, change.providerId])).toEqual([
      ['updated', 'alpha'],
      ['removed', 'beta'],
    ]);
  });

  it('keeps the last-known-good snapshot when a transient config read fails', async () => {
    let shouldFail = false;
    const { registry, publish } = store(() => {
      if (shouldFail) throw new Error('partial config write');
      return [provider('alpha')];
    });
    const first = await registry.refresh();
    shouldFail = true;

    await expect(registry.refresh()).rejects.toThrow('partial config write');
    expect(registry.getSnapshot()).toEqual(first.snapshot);
    expect(publish).toHaveBeenCalledWith({
      type: 'provider.registry.reload_failed',
      payload: {
        activeRevision: first.snapshot.revision,
        reason: 'load_failed',
      },
    });
  });

  it('commits one revision only after runtime reconciliation succeeds', async () => {
    let providers = [provider('alpha')];
    let runtimeIds = ['alpha'];
    let failRuntime = false;
    const publish = vi.fn<(event: ProviderRegistryEvent) => Promise<void>>(async () => {});
    const reconcileRuntime = vi.fn(async (view: { providers: readonly ProviderConfig[] }) => {
      if (failRuntime) throw new Error('queue reconcile failed');
      runtimeIds = view.providers.filter(item => item.enabled).map(item => item.id);
    });
    const registry = new ProviderRegistrySnapshotStore({
      loadProviders: () => providers,
      listRuntimeProviderIds: () => runtimeIds,
      reconcileRuntime,
      publish,
    });
    const first = await registry.refresh();
    expect(registry.getRuntimeView()?.revision).toBe(first.snapshot.revision);

    providers = [provider('beta')];
    failRuntime = true;
    await expect(registry.refresh()).rejects.toThrow('queue reconcile failed');
    expect(registry.getSnapshot()).toEqual(first.snapshot);
    expect(registry.getRuntimeView()?.providers.map(item => item.id)).toEqual(['alpha']);
    expect(publish).toHaveBeenLastCalledWith({
      type: 'provider.registry.reload_failed',
      payload: {
        activeRevision: first.snapshot.revision,
        reason: 'runtime_reconcile_failed',
      },
    });
  });

  it('makes an event gap recoverable from a complete content-addressed snapshot', async () => {
    const before = [toProviderRegistryManifest(provider('alpha'), new Set(['alpha']))];
    const after = [toProviderRegistryManifest(provider('beta'), new Set())];

    expect(diffProviderRegistry(before, after).map(change => ({
      type: change.type,
      providerId: change.providerId,
    }))).toEqual([
      { type: 'removed', providerId: 'alpha' },
      { type: 'added', providerId: 'beta' },
    ]);
  });
});

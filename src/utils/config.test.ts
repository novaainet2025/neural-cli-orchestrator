import { describe, expect, it, vi } from 'vitest';
import {
  applyLocalProviderConfig,
  loadJSON,
  validateProvidersFile,
  validateTopology,
} from './config.js';

describe('config JSON validation', () => {
  it('keeps loadJSON backward compatible when no validator is supplied', () => {
    const loaded = loadJSON<{ ports: unknown }>('topology.json');
    expect(loaded.ports).toBeDefined();
  });

  it('passes parsed data through the optional validator', () => {
    const validator = vi.fn((data: unknown) => ({ validated: true, data }));

    const loaded = loadJSON('topology.json', validator);

    expect(validator).toHaveBeenCalledOnce();
    expect(loaded.validated).toBe(true);
  });

  it('rejects a topology missing a required nested field', () => {
    expect(() => validateTopology({ ports: {}, paths: {} })).toThrow(
      '[config] topology.json ports.apiGateway must be a number',
    );
  });

  it('allows inferred metadata but rejects an unknown executor', () => {
    expect(() => validateProvidersFile({
      version: 1,
      updated: '2026-07-22',
      providers: [{
        id: 'test',
        command: 'test',
        runtime: { executor: 'mystery', adapter: 'generic' },
      }],
    })).toThrow('[provider-catalog] test.runtime.executor is unknown: mystery');
  });

  it('keeps the registered visual provider model distinct from its provider id', () => {
    const loaded = loadJSON<{
      providers: Array<{ id: string; model: string | null }>;
    }>('ai-providers.json');
    const visualProvider = loaded.providers.find(provider => provider.id === 'agy');

    expect(visualProvider).toBeDefined();
    expect(visualProvider?.model).toBe('agy-internal');
    expect(visualProvider?.model).not.toBe(visualProvider?.id);
  });

  it('publishes the three classified Codex models with Terra as the default', () => {
    const loaded = loadJSON<{
      providers: Array<{
        id: string;
        model: string | null;
        models?: Array<{ id: string; tier?: string; default?: boolean }>;
      }>;
    }>('ai-providers.json');
    const codex = loaded.providers.find(provider => provider.id === 'codex');

    expect(codex).toMatchObject({ model: 'gpt-5.6-terra' });
    expect(codex?.models).toEqual([
      expect.objectContaining({ id: 'gpt-5.6-luna', tier: 'light' }),
      expect.objectContaining({ id: 'gpt-5.6-terra', tier: 'balanced', default: true }),
      expect.objectContaining({ id: 'gpt-5.6-sol', tier: 'heavy' }),
    ]);
    expect(codex?.models?.some(model => model.id === codex.id)).toBe(false);
  });

  it('supports PC-local provider additions, overrides, allowlists and denylists', () => {
    const shared = validateProvidersFile({
      version: 1,
      updated: '2026-08-01',
      providers: [
        { id: 'shared-a', command: 'shared-a' },
        { id: 'shared-b', command: 'shared-b' },
      ],
    }).providers;

    const effective = applyLocalProviderConfig(shared, {
      providers: [{
        id: 'pc-only-provider',
        command: 'pc-provider',
        runtime: { executor: 'orchestrated-cli', adapter: 'generic' },
      }],
      overrides: { 'shared-a': { score: 99 } },
      allowedProviderIds: ['shared-a', 'pc-only-provider'],
      deniedProviderIds: ['shared-a'],
    });

    expect(effective.map(provider => [provider.id, provider.enabled, provider.score])).toEqual([
      ['shared-a', false, 99],
      ['shared-b', false, 70],
      ['pc-only-provider', true, 70],
    ]);
  });

  it('rejects malformed local additions atomically', () => {
    const shared = validateProvidersFile({
      version: 1,
      updated: '2026-08-01',
      providers: [{ id: 'shared', command: 'shared' }],
    }).providers;

    expect(() => applyLocalProviderConfig(shared, {
      providers: [{ id: 'shared', command: 'duplicate' }],
    })).toThrow(/duplicate local provider id/);
    expect(() => applyLocalProviderConfig(shared, {
      overrides: { missing: { enabled: false } },
    })).toThrow(/unregistered provider/);
  });

  it('uses a PC-local models overlay as the complete dynamic model catalog', () => {
    const shared = validateProvidersFile({
      version: 1,
      updated: '2026-08-01',
      providers: [{
        id: 'dynamic-host',
        type: 'api',
        endpoint: 'http://127.0.0.1:9999/v1',
        model: 'shared-model',
        models: [{ id: 'shared-model', default: true, tier: 'balanced' }],
      }],
    }).providers;

    const effective = applyLocalProviderConfig(shared, {
      overrides: {
        'dynamic-host': {
          model: 'pc-model',
          models: [{
            id: 'pc-model',
            default: true,
            tier: 'light',
            reasoningStrength: 1,
            costClass: 'minimal',
            latencyClass: 'fast',
            contextWindow: 16_384,
            availability: 'available',
          }],
        },
      },
    });

    expect(effective[0]?.models?.map(model => model.id)).toEqual(['pc-model']);
    expect(effective[0]?.models?.[0]).toMatchObject({
      tier: 'light',
      availability: 'available',
      contextWindow: 16_384,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeProviderDeclaration } from '../core/provider-catalog.js';
import { runProviderPreflight, summarizeProviderCatalog } from './provider-preflight.js';

const validProvider = normalizeProviderDeclaration({
  id: 'test-provider',
  command: 'test-provider',
  model: 'balanced-model',
  models: [{ id: 'balanced-model', default: true, tier: 'balanced' }],
});

describe('provider deployment preflight', () => {
  it('returns a secret-free catalog receipt after runtime validation', () => {
    expect(summarizeProviderCatalog([validProvider])).toEqual({
      valid: true,
      providerCount: 1,
      enabledProviderCount: 1,
      modelCount: 1,
      providers: [{
        id: 'test-provider',
        enabled: true,
        model: 'balanced-model',
        modelCount: 1,
      }],
    });
  });

  it('fails closed when the effective catalog is empty', () => {
    expect(() => summarizeProviderCatalog([])).toThrow('provider catalog is empty');
  });

  it('preserves the runtime loader error for a stale machine overlay', async () => {
    await expect(runProviderPreflight(() => {
      throw new Error(
        '[config] ai-providers.local.json is invalid: opencode.model is not an enabled catalog model',
      );
    })).rejects.toThrow('opencode.model is not an enabled catalog model');
  });
});

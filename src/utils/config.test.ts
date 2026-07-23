import { describe, expect, it, vi } from 'vitest';
import { loadJSON, validateProvidersFile, validateTopology } from './config.js';

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

  it('rejects a provider missing a required field', () => {
    expect(() => validateProvidersFile({
      version: 1,
      updated: '2026-07-22',
      providers: [{ id: 'test' }],
    })).toThrow('[config] ai-providers.json providers[0].name is required');
  });
});

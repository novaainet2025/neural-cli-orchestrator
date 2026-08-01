import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { normalizeProviderDeclaration, type ProviderConfig } from './provider-catalog.js';
import {
  appendModelRoutingReceipt,
  classifyTaskModelTier,
  persistModelRoutingReceipt,
  resolveModelRoutingDecision,
} from './model-router.js';

function arbitraryProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return normalizeProviderDeclaration({
    id: 'arbitrary-runtime',
    type: 'api',
    endpoint: 'http://127.0.0.1:9999/v1',
    capabilities: ['analysis', 'code', 'testing', 'tool-use'],
    model: 'apex-004',
    models: [
      {
        id: 'breeze-001', aliases: ['quick'], tier: 'light', reasoningStrength: 1,
        costClass: 'minimal', latencyClass: 'fast', contextWindow: 8_000,
      },
      {
        id: 'median-002', tier: 'balanced', reasoningStrength: 3,
        costClass: 'standard', latencyClass: 'standard', contextWindow: 32_000,
      },
      {
        id: 'titan-003', tier: 'heavy', reasoningStrength: 4,
        costClass: 'premium', latencyClass: 'slow', contextWindow: 128_000,
      },
      {
        id: 'apex-004', default: true, tier: 'frontier', reasoningStrength: 5,
        costClass: 'unbounded', latencyClass: 'slow', contextWindow: 256_000,
      },
    ],
    ...overrides,
  });
}

describe('dynamic model tier router', () => {
  it('scores light, balanced, heavy and frontier work from task evidence', () => {
    expect(classifyTaskModelTier('Summarize this sentence in one line.').requestedTier)
      .toBe('light');
    expect(classifyTaskModelTier('Implement an API endpoint and add tests.').requestedTier)
      .toBe('balanced');
    expect(classifyTaskModelTier(
      'Refactor concurrent multi-file modules and add regression tests.',
    ).requestedTier).toBe('heavy');

    const frontier = classifyTaskModelTier(
      'Design a distributed system architecture integration and migration for production '
      + 'security deployment with audit verification.',
      { contextTokens: 80_000, requiresTools: true, verificationRequired: true },
    );
    expect(frontier.requestedTier).toBe('frontier');
    expect(frontier.factors).toMatchObject({
      complexity: expect.any(Number),
      depth: expect.any(Number),
      risk: expect.any(Number),
      context: expect.any(Number),
      tooling: expect.any(Number),
      verification: expect.any(Number),
    });
    expect(Object.values(frontier.factors).every(value => value > 0)).toBe(true);
  });

  it.each([
    ['simple summary', 'light', 'breeze-001'],
    ['normal implementation', 'balanced', 'median-002'],
    ['deep refactor', 'heavy', 'titan-003'],
    ['critical architecture', 'frontier', 'apex-004'],
  ] as const)('maps %s to its declared %s model', (_label, tier, selectedModelId) => {
    const receipt = resolveModelRoutingDecision({
      provider: arbitraryProvider(),
      prompt: 'arbitrary input',
      registryRevision: 'registry-arbitrary-1',
      requestedTier: tier,
    });

    expect(receipt).toMatchObject({
      registryRevision: 'registry-arbitrary-1',
      providerId: 'arbitrary-runtime',
      requestedTier: tier,
      selectedTier: tier,
      selectedModelId,
      reason: 'exact_tier',
      scoreFactors: expect.any(Object),
      fallbackChain: expect.any(Array),
    });
  });

  it('honors a manual alias override independently of automatic complexity', () => {
    const receipt = resolveModelRoutingDecision({
      provider: arbitraryProvider(),
      prompt: 'Critical production security architecture migration',
      registryRevision: 'registry-override',
      manualModel: 'quick',
      maxCostClass: 'minimal',
      requiredCapabilities: ['capability-not-declared'],
      contextTokens: 999_999,
    });

    expect(receipt.reason).toBe('manual_override');
    expect(receipt.requestedModelId).toBe('quick');
    expect(receipt.selectedModelId).toBe('breeze-001');
    expect(receipt.selectedTier).toBe('light');
  });

  it('uses the nearest safe upgrade when a requested model is unavailable', () => {
    const provider = arbitraryProvider({
      model: 'apex-004',
      models: arbitraryProvider().models!.map(model => (
        model.id === 'breeze-001'
          ? { ...model, availability: 'unavailable' as const }
          : model
      )),
    });
    const receipt = resolveModelRoutingDecision({
      provider,
      prompt: 'one-line summary',
      registryRevision: 'registry-unavailable',
      requestedTier: 'light',
    });

    expect(receipt.selectedModelId).toBe('median-002');
    expect(receipt.reason).toBe('upgrade_for_safety');
    expect(receipt.fallbackChain).toContainEqual(expect.objectContaining({
      modelId: 'breeze-001',
      eligible: false,
      reasons: expect.arrayContaining(['unavailable']),
    }));
  });

  it('fails closed instead of silently changing an unavailable manual override', () => {
    const provider = arbitraryProvider({
      models: arbitraryProvider().models!.map(model => (
        model.id === 'breeze-001'
          ? { ...model, availability: 'unavailable' as const }
          : model
      )),
    });

    expect(() => resolveModelRoutingDecision({
      provider,
      prompt: 'simple',
      manualModel: 'quick',
      registryRevision: 'registry-manual-unavailable',
    })).toThrow('unknown_model: arbitrary-runtime/quick');
  });

  it('applies cost, capability and context eligibility before nearest fallback', () => {
    const receipt = resolveModelRoutingDecision({
      provider: arbitraryProvider(),
      prompt: 'large-context code task',
      registryRevision: 'registry-constraints',
      requestedTier: 'frontier',
      maxCostClass: 'premium',
      requiredCapabilities: ['testing'],
      contextTokens: 64_000,
    });

    expect(receipt.selectedModelId).toBe('titan-003');
    expect(receipt.reason).toBe('nearest_lower_fallback');
    expect(receipt.fallbackChain).toContainEqual(expect.objectContaining({
      modelId: 'apex-004',
      eligible: false,
      reasons: expect.arrayContaining(['cost_budget_exceeded:unbounded']),
    }));
  });

  it('changes immediately with model add/remove and stays deterministic within one revision', () => {
    const before = resolveModelRoutingDecision({
      provider: arbitraryProvider(),
      prompt: 'simple summary',
      registryRevision: 'registry-before',
      requestedTier: 'light',
    });
    const afterProvider = arbitraryProvider({
      models: arbitraryProvider().models!.filter(model => model.id !== 'breeze-001'),
    });
    const afterInput = {
      provider: afterProvider,
      prompt: 'simple summary',
      registryRevision: 'registry-after',
      requestedTier: 'light' as const,
    };
    const after = resolveModelRoutingDecision(afterInput);
    const repeated = resolveModelRoutingDecision(afterInput);

    expect(before.selectedModelId).toBe('breeze-001');
    expect(after.selectedModelId).toBe('median-002');
    expect(after.reason).toBe('upgrade_for_safety');
    expect(repeated).toEqual(after);
    expect(repeated.decisionFingerprint).toBe(after.decisionFingerprint);
  });

  it('keeps revisioned receipts for provider failover attempts', () => {
    const first = resolveModelRoutingDecision({
      provider: arbitraryProvider(), prompt: 'simple', registryRevision: 'registry-receipt',
    });
    const secondProvider = arbitraryProvider({ id: 'second-runtime', name: 'second-runtime' });
    const second = resolveModelRoutingDecision({
      provider: secondProvider, prompt: 'simple', registryRevision: 'registry-receipt',
    });
    const metadata = appendModelRoutingReceipt(
      appendModelRoutingReceipt({ providerAssignmentId: 'pas_1' }, first),
      second,
    );

    expect(metadata.modelRouting).toEqual(second);
    expect(metadata.modelRoutingReceipts).toEqual([first, second]);
    expect(metadata.providerAssignmentId).toBe('pas_1');
  });

  it('persists assignment-linked task receipts across provider failover', () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        metadata_json TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO tasks (id, metadata_json)
      VALUES ('task-receipt', '{"providerAssignmentId":"pas_1"}');
    `);
    const first = resolveModelRoutingDecision({
      provider: arbitraryProvider(), prompt: 'simple', registryRevision: 'registry-db',
    });
    const second = resolveModelRoutingDecision({
      provider: arbitraryProvider({ id: 'failover-runtime', name: 'failover-runtime' }),
      prompt: 'simple',
      registryRevision: 'registry-db',
    });

    expect(persistModelRoutingReceipt(database, 'task-receipt', first)).toBe(true);
    expect(persistModelRoutingReceipt(database, 'task-receipt', second)).toBe(true);
    expect(persistModelRoutingReceipt(database, 'missing-task', second)).toBe(false);
    const row = database.prepare('SELECT metadata_json FROM tasks WHERE id=?')
      .get('task-receipt') as { metadata_json: string };
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;

    expect(metadata.providerAssignmentId).toBe('pas_1');
    expect(metadata.modelRouting).toEqual(second);
    expect(metadata.modelRoutingReceipts).toEqual([first, second]);

    const outer = database.transaction(() => {
      persistModelRoutingReceipt(database, 'task-receipt', first);
      throw new Error('rollback outer unit of work');
    });
    expect(outer).toThrow('rollback outer unit of work');
    const rolledBack = JSON.parse((database.prepare(
      'SELECT metadata_json FROM tasks WHERE id=?',
    ).get('task-receipt') as { metadata_json: string }).metadata_json) as Record<string, unknown>;
    expect(rolledBack.modelRouting).toEqual(second);
    expect(rolledBack.modelRoutingReceipts).toEqual([first, second]);
    database.close();
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildProviderCatalog,
  normalizeProviderDeclaration,
  providersForDepartment,
  resolveProviderModel,
  resolveProviderRuntime,
} from './provider-catalog.js';

describe('ProviderCatalog SSOT normalization', () => {
  it('turns a minimal generic CLI declaration into an enabled runnable provider', () => {
    const provider = normalizeProviderDeclaration({
      id: 'new-worker',
      command: 'new-worker',
    });

    expect(provider.enabled).toBe(true);
    expect(provider.role).toBe('Generalist');
    expect(provider.capabilities).toEqual(['analysis', 'reasoning', 'writing', 'code']);
    expect(provider.runtime).toEqual({
      executor: 'orchestrated-cli',
      adapter: 'generic',
      profile: 'default',
      promptTransport: 'stdin',
    });
    expect(provider.routing?.departments).toEqual(['information', 'execution']);
    expect(provider.routing?.taskTypes).toContain('general');
    expect(provider.routing?.discussionEligible).toBe(true);
    expect(provider.routing?.discussionPriority).toBe(provider.routing?.priority);
  });

  it('infers conventional role/adapter but lets every inferred policy be overridden', () => {
    const inferred = normalizeProviderDeclaration({
      id: 'fast-codex',
      command: 'codex',
    });
    expect(inferred.role).toBe('Engineer');
    expect(inferred.runtime?.adapter).toBe('codex');

    const overridden = normalizeProviderDeclaration({
      id: 'review-box',
      command: 'custom',
      role: 'Reviewer',
      score: 91,
      capabilities: ['review', 'security'],
      runtime: { executor: 'orchestrated-cli', adapter: 'generic' },
      routing: {
        tier: 'brain',
        departments: ['quality'],
        taskTypes: ['review'],
        discussionEligible: false,
        discussionPriority: 901,
      },
    });
    expect(overridden).toMatchObject({
      role: 'Reviewer',
      score: 91,
      capabilities: ['review', 'security'],
      runtime: { executor: 'orchestrated-cli', adapter: 'generic' },
      routing: {
        tier: 'brain',
        departments: ['quality'],
        taskTypes: ['review'],
        discussionEligible: false,
        discussionPriority: 901,
      },
    });
  });

  it('rejects duplicate providers and unknown/unsupported executors before boot', () => {
    expect(() => buildProviderCatalog([
      { id: 'same', command: 'one' },
      { id: 'same', command: 'two' },
    ])).toThrow('duplicate provider id');

    expect(() => normalizeProviderDeclaration({
      id: 'mystery',
      command: 'mystery',
      runtime: { executor: 'unknown' as never, adapter: 'generic' },
    })).toThrow('runtime.executor is unknown');

    expect(() => normalizeProviderDeclaration({
      id: 'unsupported-native',
      command: 'custom',
      runtime: { executor: 'native-cli', adapter: 'generic' },
    })).toThrow('native-cli currently requires adapter=claude');
  });

  it('fails fast on malformed JSON and nested local-override shapes', () => {
    const malformed: Array<[Record<string, unknown>, string]> = [
      [{ id: 'bad-enabled', command: 'bad', enabled: 'yes' }, '.enabled must be boolean'],
      [{ id: 'null-enabled', command: 'bad', enabled: null }, '.enabled must be boolean'],
      [{ id: 'bad-command', command: 42 }, '.command must be string or null'],
      [{ id: 'bad-args', command: 'bad', args: ['ok', 7] }, '.args[1] must be string'],
      [{ id: 'bad-env', command: 'bad', env: { TOKEN: true } }, '.env.TOKEN must be string'],
      [{ id: 'bad-permissions', command: 'bad', permissions: { canSupervise: 'yes' } },
        '.permissions.canSupervise must be boolean'],
      [{ id: 'bad-persona', command: 'bad', persona: { tone: 'quiet', style: 'brief' } },
        '.persona.systemPrompt must be string'],
      [{ id: 'bad-health', command: 'bad', healthCheck: { timeout: 5000 } },
        '.healthCheck must define command or url'],
      [{ id: 'bad-model-shape', command: 'bad', models: [{ id: 'v1', enabled: 'yes' }] },
        '.models[0].enabled must be boolean'],
      [{ id: 'bad-model-tier', command: 'bad', models: [{ id: 'v1', tier: 'giant' }] },
        '.models[0].tier is unknown'],
      [{ id: 'bad-model-reasoning', command: 'bad', models: [{ id: 'v1', reasoningStrength: 6 }] },
        '.models[0].reasoningStrength must be an integer from 1 to 5'],
      [{ id: 'bad-model-cost', command: 'bad', models: [{ id: 'v1', costClass: 'cheap' }] },
        '.models[0].costClass is unknown'],
      [{ id: 'bad-model-context', command: 'bad', models: [{ id: 'v1', contextWindow: 0 }] },
        '.models[0].contextWindow must be a positive integer or null'],
      [{ id: 'bad-model-availability', command: 'bad', models: [{ id: 'v1', availability: 'gone' }] },
        '.models[0].availability is unknown'],
      [{ id: 'bad-model-extra', command: 'bad', models: [{ id: 'v1', provider: 'coupled' }] },
        '.models[0] has unknown field(s): provider'],
      [{ id: 'bad-profile', command: 'bad', runtime: { profile: 'unsafe' } },
        '.runtime.profile is unknown'],
      [{
        id: 'bad-codex-transport', command: 'codex',
        runtime: { adapter: 'codex', promptTransport: 'stdin' },
      }, '.codex adapter requires runtime.promptTransport=argv'],
      [{ id: 'bad-routing-priority', command: 'bad', routing: { priority: 'first' } },
        '.routing.priority must be number'],
      [{
        id: 'bad-discussion-eligible', command: 'bad',
        routing: { discussionEligible: 'yes' },
      }, '.routing.discussionEligible must be boolean'],
      [{
        id: 'bad-discussion-priority', command: 'bad',
        routing: { discussionPriority: 'first' },
      }, '.routing.discussionPriority must be number'],
      [{
        id: 'bad-key-rotation', command: 'bad',
        keyRotation: {
          enabled: true, envVar: 'KEYS', delimiter: ',', maxKeys: 0, cooldownMs: 1000,
        },
      }, '.keyRotation.maxKeys must be a positive integer'],
      [{ id: 'bad-api-config', command: 'bad', apiConfig: {} },
        '.apiConfig.primary must be an object'],
      [{
        id: 'bad-api-fallback', command: 'bad',
        apiConfig: {
          primary: { provider: 'one', baseUrl: 'http://one', apiKeyRef: 'ONE_KEY', model: 'm1' },
          fallback: { provider: 'two', baseUrl: 'http://two', apiKeyRef: 7, model: 'm2' },
        },
      }, '.apiConfig.fallback.apiKeyRef must be string or null'],
    ];

    for (const [declaration, message] of malformed) {
      expect(() => normalizeProviderDeclaration(declaration as never)).toThrow(message);
    }

    const base = normalizeProviderDeclaration({ id: 'base-worker', command: 'worker' });
    const brokenLocalOverride = { persona: { tone: 'only-this-field' } };
    expect(() => normalizeProviderDeclaration({ ...base, ...brokenLocalOverride } as never))
      .toThrow('.persona.systemPrompt must be string');
    expect(() => normalizeProviderDeclaration({
      ...base,
      permissions: { canSupervise: true },
    } as never)).toThrow('.permissions.canInitiateCollaboration must be boolean');

    expect(() => normalizeProviderDeclaration({ id: 'empty-models', command: 'bad', models: [] }))
      .toThrow('is enabled but has no enabled model');
  });

  it('owns model add/delete eligibility through IDs, aliases and one default', () => {
    const provider = normalizeProviderDeclaration({
      id: 'model-host',
      type: 'api',
      endpoint: 'http://127.0.0.1:9999/v1',
      models: [
        { id: 'large-v2', aliases: ['large'], default: true },
        { id: 'small-v1', aliases: ['small'] },
      ],
    });
    expect(provider.model).toBe('large-v2');
    expect(provider.models?.filter(model => model.default)).toHaveLength(1);
    expect(provider.models?.[0]).toMatchObject({
      tier: 'balanced',
      reasoningStrength: 3,
      costClass: 'standard',
      latencyClass: 'standard',
      contextWindow: null,
      availability: 'available',
    });
    expect(resolveProviderModel(provider, 'small')).toBe('small-v1');
    expect(() => resolveProviderModel(provider, 'deleted-v0')).toThrow(
      'unknown_model: model-host/deleted-v0',
    );

    expect(() => normalizeProviderDeclaration({
      id: 'bad-models',
      type: 'api',
      endpoint: 'http://127.0.0.1:9999/v1',
      models: [{ id: 'one', aliases: ['shared'] }, { id: 'two', aliases: ['shared'] }],
    })).toThrow('duplicate bad-models model id/alias');
  });

  it('does not regenerate a provider removed from the declaration list', () => {
    const catalog = buildProviderCatalog([
      { id: 'active-one', command: 'one' },
      { id: 'active-two', command: 'two', capabilities: ['review'] },
    ]);
    const afterRemoval = buildProviderCatalog([
      { id: 'active-two', command: 'two', capabilities: ['review'] },
    ]);

    expect(catalog.map(provider => provider.id)).toContain('active-one');
    expect(afterRemoval.map(provider => provider.id)).toEqual(['active-two']);
    expect(providersForDepartment(afterRemoval, 'quality').map(provider => provider.id))
      .toEqual(['active-two']);
  });

  it('infers a read-only Codex tool worker without provider-id branching', () => {
    expect(resolveProviderRuntime({
      id: 'structured-tools',
      command: 'codex',
      role: 'ToolUser',
      capabilities: ['tool-use', 'function-calling'],
    })).toEqual({
      executor: 'orchestrated-cli',
      adapter: 'codex',
      profile: 'readonly-tool-worker',
      promptTransport: 'argv',
    });
  });
});

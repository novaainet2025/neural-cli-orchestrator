import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const {
  mockExeca,
  mockChatCreate,
  mockEventPublish,
  loadEnabledProviders,
  env,
  mockProviders,
} = vi.hoisted(() => {
  const providers = [
    {
      id: 'aider',
      role: 'execution',
      type: 'orchestrated',
      command: 'aider',
      args: [],
      env: {} as Record<string, string>,
      persona: { systemPrompt: 'test aider prompt' },
    },
    {
      id: 'claude-code',
      role: 'management',
      type: 'native',
      command: 'claude',
      args: ['--test-flag'],
      env: { SOME_VAR: 'val' } as Record<string, string>,
      persona: { systemPrompt: 'test claude prompt' },
    },
    {
      id: 'api-tools',
      role: 'execution',
      type: 'api',
      command: null,
      args: [],
      env: {} as Record<string, string>,
      model: 'test-model',
      endpoint: 'http://127.0.0.1:9999/v1',
      concurrency: 1,
      persona: { systemPrompt: 'test api prompt' },
    },
    {
      id: 'cursor-agent',
      role: 'review',
      type: 'cli',
      command: 'cursor-agent',
      args: [],
      env: {} as Record<string, string>,
      model: 'cursor',
      persona: { systemPrompt: 'test cursor prompt' },
    },
  ];
  return {
    mockProviders: providers,
    loadEnabledProviders: vi.fn(() => providers),
    env: { PROJECT_DIR: '/dummy/project' },
    mockChatCreate: vi.fn(),
    mockEventPublish: vi.fn(async () => undefined),
    mockExeca: vi.fn(async (cmd: string, args: string[], opts: any) => {
      if (args.includes('Reply exactly: NCO_PROVIDER_PROBE_OK')) {
        return { stdout: 'NCO_PROVIDER_PROBE_OK', stderr: '', exitCode: 0 };
      }
      return { stdout: 'mocked output', stderr: '', exitCode: 0 };
    }),
  };
});

vi.mock('../utils/config.js', () => ({
  loadEnabledProviders,
  // provider-registry(라우팅 SSOT)가 등록 전체 목록을 이 export 로 읽는다.
  loadProviders: loadEnabledProviders,
  env,
  getApiKeys: (envVar: string, delimiter = ',') => {
    const raw = process.env[envVar] || '';
    return raw.split(delimiter).map(k => k.trim()).filter(Boolean);
  },
}));

vi.mock('execa', () => ({
  execa: mockExeca,
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: (...args: unknown[]) => mockChatCreate(...args),
      },
    };
  },
}));

vi.mock('../storage/database.js', () => ({
  getDb: () => { throw new Error('database unavailable in unit test'); },
}));

vi.mock('../core/event-bus.js', () => ({
  eventBus: {
    publish: mockEventPublish,
  },
}));

vi.mock('../core/shared-state.js', () => ({
  sharedState: {
    setAgentState: vi.fn(),
    heartbeat: vi.fn(),
    getAllAgentStates: vi.fn(async () => ({})),
    isAgentAlive: vi.fn(async () => true),
    getAgentState: vi.fn(async () => ({ status: 'idle' })),
  },
}));

vi.mock('../security/verification-gate.js', () => ({
  verificationGate: {
    verify: vi.fn(async () => ({ passed: true, results: [] })),
  },
}));

const mockVectorMemorySearch = vi.fn(async (_agentId: string, _query: string, _k?: number): Promise<any[]> => []);
const mockVectorMemoryAdd = vi.fn();

vi.mock('../core/vector-memory.js', () => ({
  vectorMemory: {
    search: mockVectorMemorySearch,
    add: mockVectorMemoryAdd,
  },
}));

vi.mock('../core/knowledge-base.js', () => ({
  knowledgeBase: {
    extractFromTaskResult: vi.fn(),
  },
}));

vi.mock('../core/agent-evolver.js', () => ({
  agentEvolver: {
    record: vi.fn(),
  },
}));

vi.mock('../security/trajectory-guard.js', () => ({
  trajectoryGuard: {
    beginTask: vi.fn(),
    endTask: vi.fn(),
    beforeTool: vi.fn(async () => ({ allowed: true })),
    afterTool: vi.fn(async () => undefined),
  },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  agentManager,
  classifyAgent,
  classifyIncompleteAnswer,
  formatProviderUnavailableError,
  isNonCircuitCancellation,
  PROVIDER_PROBE_PROMPT,
} from './agent-manager.js';
import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';
import { normalizeProviderDeclaration } from '../core/provider-catalog.js';
import { providerAdmissionGate } from '../core/provider-admission-gate.js';

describe('AgentManager', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockVectorMemorySearch.mockResolvedValue([]);
    circuitBreakerRegistry.reset('aider');
    circuitBreakerRegistry.reset('claude-code');
    circuitBreakerRegistry.reset('api-tools');
    circuitBreakerRegistry.reset('cursor-agent');
  });

  it('classifies arbitrary provider ids from runtime descriptors', () => {
    const provider = (id: string, executor: string) => ({
      id,
      command: executor === 'openai-api' ? null : 'provider-cli',
      endpoint: executor === 'openai-api' ? 'http://localhost:9999/v1' : undefined,
      runtime: { executor, adapter: 'generic' },
    }) as any;

    expect(classifyAgent(provider('added-after-deploy', 'orchestrated-cli'))).toBe('orchestrated-cli');
    expect(classifyAgent(provider('pc-local-api', 'openai-api'))).toBe('openai-api');
  });

  it('forwards the dynamically selected model to an arbitrary native executor', async () => {
    const dynamic = normalizeProviderDeclaration({
      id: 'unbranded-native',
      command: 'model-cli',
      runtime: { executor: 'native-cli', adapter: 'claude' },
      capabilities: ['analysis', 'architecture'],
      model: 'frontier-z',
      models: [
        {
          id: 'light-x', tier: 'light', reasoningStrength: 1,
          costClass: 'minimal', latencyClass: 'fast', contextWindow: 16_000,
        },
        {
          id: 'frontier-z', default: true, tier: 'frontier', reasoningStrength: 5,
          costClass: 'unbounded', latencyClass: 'slow', contextWindow: 128_000,
        },
      ],
    });
    circuitBreakerRegistry.reset(dynamic.id);
    await agentManager.reloadProviders([dynamic], 'registry-executor-e2e');

    const result = await agentManager.executeTask(
      dynamic.id,
      'Summarize this sentence in one line.',
      { projectDir: '/dummy/project', compact: true },
    );

    expect(result.success).toBe(true);
    expect(result.modelRouting).toMatchObject({
      providerId: dynamic.id,
      registryRevision: 'registry-executor-e2e',
      requestedTier: 'light',
      selectedModelId: 'light-x',
      selectedTier: 'light',
    });
    const execution = mockExeca.mock.calls.find(([command]) => command === 'model-cli');
    expect(execution).toBeDefined();
    expect(execution?.[1]).toEqual(expect.arrayContaining(['--model', 'light-x']));
  });

  it('rejects a queued task after reconciliation advances its provider revision', async () => {
    const dynamic = normalizeProviderDeclaration({
      id: 'generation-pinned-cli',
      command: 'generation-cli',
      runtime: { executor: 'native-cli', adapter: 'claude' },
      model: 'stable-model',
    });
    circuitBreakerRegistry.reset(dynamic.id);
    await agentManager.reloadProviders([dynamic], 'registry-before');
    const endReconciliation = await providerAdmissionGate.beginReconciliation();

    try {
      const execution = agentManager.executeTask(
        dynamic.id,
        'must not execute against another provider generation',
        {
          taskId: 'queued-before-reconciliation',
          projectDir: '/dummy/project',
          routingMetadata: { providerRevision: 'registry-before' },
        },
      );
      await Promise.resolve();
      expect(mockExeca).not.toHaveBeenCalled();

      await agentManager.reloadProviders([dynamic], 'registry-after');
      endReconciliation();

      await expect(execution).resolves.toMatchObject({
        taskId: 'queued-before-reconciliation',
        agentId: dynamic.id,
        success: false,
        iterations: 0,
        toolCalls: 0,
        error: 'provider_registry_revision_conflict: requested=registry-before active=registry-after',
      });
      expect(mockExeca).not.toHaveBeenCalled();
      expect(providerAdmissionGate.snapshot().active).toBe(0);
    } finally {
      endReconciliation();
    }
  });

  it('keeps unversioned legacy internal execution compatible', async () => {
    const dynamic = normalizeProviderDeclaration({
      id: 'legacy-internal-cli',
      command: 'legacy-cli',
      runtime: { executor: 'native-cli', adapter: 'claude' },
      model: 'stable-model',
    });
    circuitBreakerRegistry.reset(dynamic.id);
    await agentManager.reloadProviders([dynamic], 'registry-current');

    const result = await agentManager.executeTask(
      dynamic.id,
      'legacy internal execution without revision metadata',
      { projectDir: '/dummy/project' },
    );

    expect(result.success).toBe(true);
    expect(mockExeca).toHaveBeenCalledWith(
      'legacy-cli',
      expect.any(Array),
      expect.any(Object),
    );
  });

  it.each(['', '   '])('rejects an explicitly blank provider revision: %j', async providerRevision => {
    const dynamic = normalizeProviderDeclaration({
      id: 'invalid-revision-cli',
      command: 'invalid-revision-cli',
      runtime: { executor: 'native-cli', adapter: 'claude' },
      model: 'stable-model',
    });
    circuitBreakerRegistry.reset(dynamic.id);
    await agentManager.reloadProviders([dynamic], 'registry-current');

    const result = await agentManager.executeTask(
      dynamic.id,
      'must not execute with an explicitly blank provider revision',
      {
        projectDir: '/dummy/project',
        routingMetadata: { providerRevision },
      },
    );

    expect(result).toMatchObject({
      success: false,
      iterations: 0,
      toolCalls: 0,
      error: 'provider_registry_revision_conflict: requested=invalid active=registry-current',
    });
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('records and invalidates inference evidence on terminal CLI outcomes', async () => {
    await agentManager.init();
    const success = await agentManager.executeTask(
      'cursor-agent',
      'Return a substantive test response',
      { projectDir: '/dummy/project' },
    );
    expect(success.success).toBe(true);
    expect(circuitBreakerRegistry.getInferenceEvidence('cursor-agent')).toMatchObject({
      success: true,
    });

    mockExeca.mockRejectedValueOnce(new Error('provider process failed'));
    const failed = await agentManager.executeTask(
      'cursor-agent',
      'Run a failing test response',
      { projectDir: '/dummy/project' },
    );
    expect(failed.success).toBe(false);
    expect(circuitBreakerRegistry.getInferenceEvidence('cursor-agent')).toMatchObject({
      success: false,
    });
  });

  afterEach(() => {
    agentManager.destroy();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('injectDerivedKeys binds OPENROUTER_API_KEY from OPENROUTER_API_KEYS plural variable', async () => {
    process.env.OPENROUTER_API_KEYS = 'key1,key2,key3';
    
    const aider = mockProviders.find(p => p.id === 'aider')!;
    aider.env = {} as Record<string, string>;

    await agentManager.init();

    expect(aider.env.OPENROUTER_API_KEY).toBe('key1');
    
    delete process.env.OPENROUTER_API_KEYS;
    agentManager.destroy();
  });

  it('compact discussion execution skips task memory and repository verification post-processing', async () => {
    await agentManager.init();

    const result = await agentManager.executeTask(
      'claude-code',
      'Discussion R1 compact proposal',
      { projectDir: '/dummy/project', compact: true },
    );

    expect(result.success).toBe(true);
    expect(mockVectorMemorySearch).not.toHaveBeenCalled();
    expect(mockVectorMemoryAdd).not.toHaveBeenCalled();
    expect(mockExeca).not.toHaveBeenCalledWith(
      'git',
      ['diff', '--name-only'],
      expect.anything(),
    );
  });

  it('enforces the total wall clock through post-task memory and releases admission', async () => {
    await agentManager.init();
    let markMemoryStarted!: () => void;
    const memoryStarted = new Promise<void>(resolve => {
      markMemoryStarted = resolve;
    });
    mockVectorMemoryAdd.mockImplementationOnce(() => new Promise<void>(() => {
      markMemoryStarted();
    }));

    const execution = agentManager.executeTask(
      'claude-code',
      'Return a substantive result before post-processing',
      { projectDir: '/dummy/project', timeoutMs: 100 },
    );
    await memoryStarted;
    expect(providerAdmissionGate.snapshot().active).toBe(1);

    const result = await execution;

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/timeout/i) });
    expect(providerAdmissionGate.snapshot().active).toBe(0);
    expect(circuitBreakerRegistry.getInferenceEvidence('claude-code')).toMatchObject({ success: true });
    expect(circuitBreakerRegistry.getSnapshot('claude-code')).toMatchObject({
      state: 'closed',
      failureCount: 0,
    });
  });

  it('reports provider unavailability with state and reason', () => {
    expect(formatProviderUnavailableError('codex', {
      state: 'open',
      reason: 'quota',
    })).toBe('provider_unavailable: codex (open/quota)');
  });

  it('does not treat graceful process interruption as a circuit failure', async () => {
    await agentManager.init();
    mockExeca.mockResolvedValueOnce({
      stdout: '',
      stderr: 'Aborting operation...',
      shortMessage: 'Command failed with exit code 130',
      exitCode: 130,
      isCanceled: false,
      timedOut: false,
    } as any);

    const result = await agentManager.executeTask(
      'cursor-agent',
      'read-only cancellation regression',
      { projectDir: '/dummy/project' },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/exit=130.*Aborting operation/i),
    });
    expect(circuitBreakerRegistry.getSnapshot('cursor-agent')).toMatchObject({
      state: 'closed',
      failureCount: 0,
    });
  });

  it('keeps execution timeouts circuit-relevant', () => {
    expect(isNonCircuitCancellation(
      Object.assign(new Error('cursor-agent: CLI timed out'), { canceled: true }),
    )).toBe(false);
  });

  it('does not penalize providers stopped by discussion coordination', () => {
    expect(isNonCircuitCancellation(
      new Error('ollama: discussion_quorum_reached'),
    )).toBe(true);
    expect(isNonCircuitCancellation(
      new Error('discussion_cancelled'),
    )).toBe(true);
  });

  it('requires a structural cancellation signal instead of loose abort text', () => {
    expect(isNonCircuitCancellation(
      new Error('provider failed while aborting operation'),
    )).toBe(false);
    expect(isNonCircuitCancellation(
      new Error('provider failed with exit=1300'),
    )).toBe(false);
    expect(isNonCircuitCancellation(
      new Error('provider exited with code 1'),
      undefined,
      'SIGINT',
    )).toBe(true);
  });

  it('rejects non-answers while preserving an explicitly requested unknown literal', () => {
    expect(
      classifyIncompleteAnswer(
        'nova-cli 장단점 알려줘',
        'Let me look at the nova-cli project to understand what it is',
      ),
    ).toContain('future-intent');
    expect(
      classifyIncompleteAnswer(
        'nova-cli 장단점 알려줘',
        'Let me explore the codebase first.',
      ),
    ).toContain('future-intent');
    expect(
      classifyIncompleteAnswer(
        'nova-cli 장단점 알려줘',
        '먼저 저장소를 살펴보겠습니다.',
      ),
    ).toContain('future-intent');
    expect(
      classifyIncompleteAnswer(
        'nova-use 개선안을 토론해',
        'Discussion 시작 전, nova-use 프로젝트를 탐색하여 현재 상태를 파악합니다',
      ),
    ).toContain('future-intent');
    expect(
      classifyIncompleteAnswer(
        'nova-use 개선안을 토론해',
        'Before I provide the analysis, let me verify the key claims in the actual project files',
      ),
    ).toContain('future-intent');
    expect(
      classifyIncompleteAnswer(
        'nova-cli 장단점 알려줘',
        'unknown [Evidence Tier 3] No verified source',
      ),
    ).toContain('unknown');
    expect(classifyIncompleteAnswer('Return exactly unknown', 'unknown')).toBeUndefined();
    expect(classifyIncompleteAnswer('상태를 알려줘', '현재 상태는 정상입니다.')).toBeUndefined();
  });

  it('injects NCO_HOOK_DISABLED environment variable when spawning claude-code subprocess', async () => {
    await agentManager.init();
    
    const result = await agentManager.executeTask('claude-code', 'test prompt');

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.output).toBe('mocked output');

    expect(mockExeca).toHaveBeenCalled();
    const [cmd, args, opts] = mockExeca.mock.calls[0];
    
    expect(cmd).toBe('claude');
    expect(args).toContain('--test-flag');
    expect(args).toContain('test prompt');
    
    expect(opts.env).toBeDefined();
    expect(opts.env.NCO_HOOK_DISABLED).toBe('1');
    expect(opts.env.SOME_VAR).toBe('val');

    agentManager.destroy();
  });

  it('runs a lightweight provider probe outside the project workspace', async () => {
    await agentManager.init();

    const recovered = await agentManager.probeProvider('claude-code');

    expect(recovered).toBe(true);
    const [cmd, args, opts] = mockExeca.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toContain('Reply exactly: NCO_PROVIDER_PROBE_OK');
    expect(opts.cwd).not.toBe(env.PROJECT_DIR);
    expect(opts.timeout).toBe(30_000);

    agentManager.destroy();
  });

  it('holds one provider generation through sentinel evidence and circuit recovery', async () => {
    await agentManager.init();
    circuitBreakerRegistry.recordFailure('claude-code', 'transient provider failure', {
      failureThreshold: 1,
      resetTimeoutMs: 60_000,
    });
    let markProbeStarted!: () => void;
    let finishProbe!: () => void;
    const probeStarted = new Promise<void>(resolve => {
      markProbeStarted = resolve;
    });
    mockExeca.mockImplementationOnce(() => new Promise(resolve => {
      markProbeStarted();
      finishProbe = () => resolve({
        stdout: 'NCO_PROVIDER_PROBE_OK',
        stderr: '',
        exitCode: 0,
      });
    }));

    const probe = agentManager.probeProvider('claude-code', PROVIDER_PROBE_PROMPT, 1_000);
    await probeStarted;
    const reconciliation = providerAdmissionGate.beginReconciliation(1_000);
    await Promise.resolve();
    expect(providerAdmissionGate.snapshot()).toMatchObject({ reconciling: true, active: 1 });

    finishProbe();
    await expect(probe).resolves.toBe(true);
    const endReconciliation = await reconciliation;
    expect(circuitBreakerRegistry.getInferenceEvidence('claude-code')).toMatchObject({ success: true });
    expect(circuitBreakerRegistry.getSnapshot('claude-code')).toMatchObject({
      state: 'closed',
      failureCount: 0,
    });
    endReconciliation();
  });

  it('uses substantive API sentinel inference instead of GET health for recovery', async () => {
    await agentManager.init();
    circuitBreakerRegistry.recordFailure('api-tools', 'quota exceeded', {
      failureThreshold: 1,
      resetTimeoutMs: 60_000,
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'NCO_PROVIDER_PROBE_OK' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(agentManager.probeProvider('api-tools')).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9999/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      messages: [{ role: 'user', content: PROVIDER_PROBE_PROMPT }],
    });
    expect(circuitBreakerRegistry.getInferenceEvidence('api-tools')).toMatchObject({ success: true });
    expect(circuitBreakerRegistry.getSnapshot('api-tools').state).toBe('closed');
  });

  it('does not close an API circuit from a transport health GET alone', async () => {
    await agentManager.init();
    circuitBreakerRegistry.recordFailure('api-tools', 'transient provider failure', {
      failureThreshold: 1,
      resetTimeoutMs: 60_000,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const provider = agentManager.getProvider('api-tools')!;

    await expect((agentManager as any).healthCheckApiProvider('api-tools', provider))
      .resolves.toBe(true);

    expect(circuitBreakerRegistry.getSnapshot('api-tools').state).toBe('open');
    expect(circuitBreakerRegistry.getInferenceEvidence('api-tools')).toBeNull();
  });

  it('releases provider admission when a sentinel probe has no endpoint', async () => {
    const apiProvider = mockProviders.find(provider => provider.id === 'api-tools')!;
    await agentManager.reloadProviders([{
      ...apiProvider,
      id: 'api-without-endpoint',
      endpoint: undefined,
      runtime: { executor: 'openai-api', adapter: 'generic' },
    } as any]);

    await expect(agentManager.probeProvider('api-without-endpoint')).resolves.toBe(false);

    expect(providerAdmissionGate.snapshot().active).toBe(0);
    expect(circuitBreakerRegistry.getInferenceEvidence('api-without-endpoint'))
      .toMatchObject({ success: false });
  });

  it('accepts an ANSI-wrapped exact Cursor recovery response with non-color env parity', async () => {
    await agentManager.init();
    mockExeca.mockResolvedValueOnce({
      stdout: '\u001b[32mNCO_PROVIDER_PROBE_OK\u001b[0m\n',
      stderr: '',
      exitCode: 0,
    });

    const recovered = await agentManager.probeProvider(
      'cursor-agent',
      'Reply exactly: NCO_PROVIDER_PROBE_OK',
      30_000,
      'composer-2.5',
    );

    expect(recovered).toBe(true);
    const [, , opts] = mockExeca.mock.calls[0];
    expect(opts.env).toMatchObject({
      NO_COLOR: '1',
      TERM: 'dumb',
    });
  });

  it('requires the exact recovery sentinel for non-Cursor CLI adapters', async () => {
    const cursor = mockProviders.find(provider => provider.id === 'cursor-agent')!;
    const dynamic = {
      ...cursor,
      id: 'pc-codex-worker',
      command: 'codex',
      runtime: { executor: 'orchestrated-cli', adapter: 'codex' },
    } as any;
    await agentManager.reloadProviders([dynamic]);
    mockExeca
      .mockResolvedValueOnce({
        stdout: 'authentication warning but process exited cleanly',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: '\u001b[32mNCO_PROVIDER_PROBE_OK\u001b[0m\n',
        stderr: '',
        exitCode: 0,
      });

    await expect(agentManager.probeProvider(
      'pc-codex-worker',
      'Reply exactly: NCO_PROVIDER_PROBE_OK',
    )).resolves.toBe(false);
    await expect(agentManager.probeProvider(
      'pc-codex-worker',
      'Reply exactly: NCO_PROVIDER_PROBE_OK',
    )).resolves.toBe(true);
  });

  it('builds adapter-specific probes for an arbitrary provider id', async () => {
    const cursor = mockProviders.find(provider => provider.id === 'cursor-agent')!;
    const dynamic = {
      ...cursor,
      id: 'pc-reviewer',
      runtime: { executor: 'orchestrated-cli', adapter: 'cursor' },
    } as any;
    await agentManager.reloadProviders([dynamic]);
    mockExeca.mockResolvedValueOnce({
      stdout: 'NCO_PROVIDER_PROBE_OK',
      stderr: '',
      exitCode: 0,
    });

    const recovered = await agentManager.probeProvider(
      'pc-reviewer',
      'Reply exactly: NCO_PROVIDER_PROBE_OK',
      30_000,
      'auto',
    );

    expect(recovered).toBe(true);
    const [, args] = mockExeca.mock.calls[0];
    expect(args).toContain('--print');
    expect(args).toContain('--model');
  });

  it('uses one explicit fallback-model probe before closing a recovered Cursor circuit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T05:00:00.000Z'));
    await agentManager.init();

    circuitBreakerRegistry.recordFailure('cursor-agent', 'transient provider failure', {
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    vi.advanceTimersByTime(50);

    await (agentManager as any).probeGatedCliProvider('cursor-agent');

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const [command, args] = mockExeca.mock.calls[0];
    expect(command).toBe('cursor-agent');
    expect(args).toEqual(expect.arrayContaining([
      '--print',
      '--trust',
      '--model',
      'auto',
      'Reply exactly: NCO_PROVIDER_PROBE_OK',
    ]));
    expect(circuitBreakerRegistry.getSnapshot('cursor-agent').state).toBe('closed');
    expect(circuitBreakerRegistry.getInferenceEvidence('cursor-agent')).toMatchObject({
      success: true,
    });
    expect(mockEventPublish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'provider:recovery-probe',
      agentId: 'cursor-agent',
      success: true,
    }));
  });

  it.each([
    ['quota', 'quota exceeded'],
    ['rate-limit', 'HTTP 429: too many requests'],
  ])('health monitor probes an expired Cursor %s circuit and closes it on exact success', async (
    expectedReason,
    failure,
  ) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T05:00:00.000Z'));
    await agentManager.init();
    (agentManager as any).providers = new Map([
      ['cursor-agent', mockProviders.find(provider => provider.id === 'cursor-agent')!],
    ]);

    circuitBreakerRegistry.recordFailure('cursor-agent', failure, {
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    const opened = circuitBreakerRegistry.getSnapshot('cursor-agent');
    expect(opened).toMatchObject({ state: 'open', reason: expectedReason });
    expect(opened.cooldownUntil).not.toBeNull();
    vi.setSystemTime(opened.cooldownUntil! + 1);

    await (agentManager as any).healthCheck();

    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(circuitBreakerRegistry.getSnapshot('cursor-agent')).toMatchObject({
      state: 'closed',
      reason: null,
    });
  });

  it('preserves the quota cooldown when a Cursor recovery probe fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T05:00:00.000Z'));
    await agentManager.init();
    (agentManager as any).providers = new Map([
      ['cursor-agent', mockProviders.find(provider => provider.id === 'cursor-agent')!],
    ]);
    mockExeca.mockResolvedValueOnce({
      stdout: 'quota remains unavailable',
      stderr: '',
      exitCode: 0,
    });

    circuitBreakerRegistry.recordFailure('cursor-agent', 'quota exceeded', {
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    const opened = circuitBreakerRegistry.getSnapshot('cursor-agent');
    vi.setSystemTime(opened.cooldownUntil! + 1);

    await (agentManager as any).healthCheck();

    const reopened = circuitBreakerRegistry.getSnapshot('cursor-agent');
    expect(reopened).toMatchObject({ state: 'open', reason: 'quota' });
    expect(circuitBreakerRegistry.getInferenceEvidence('cursor-agent')).toMatchObject({
      success: false,
    });
    expect(reopened.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it('does not automatically probe a Cursor auth circuit', async () => {
    await agentManager.init();
    (agentManager as any).providers = new Map([
      ['cursor-agent', mockProviders.find(provider => provider.id === 'cursor-agent')!],
    ]);
    circuitBreakerRegistry.recordFailure('cursor-agent', 'invalid API key', {
      failureThreshold: 1,
    });

    await (agentManager as any).healthCheck();

    expect(mockExeca).not.toHaveBeenCalled();
    expect(circuitBreakerRegistry.getSnapshot('cursor-agent')).toMatchObject({
      state: 'open',
      reason: 'auth',
      cooldownUntil: null,
    });
  });

  it('reopens the Cursor circuit when the recovery probe returns the wrong output', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T05:00:00.000Z'));
    await agentManager.init();
    mockExeca.mockResolvedValueOnce({
      stdout: 'unexpected response',
      stderr: '',
      exitCode: 0,
    });

    circuitBreakerRegistry.recordFailure('cursor-agent', 'transient provider failure', {
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    vi.advanceTimersByTime(50);

    await (agentManager as any).probeGatedCliProvider('cursor-agent');

    expect(circuitBreakerRegistry.getSnapshot('cursor-agent')).toMatchObject({
      state: 'open',
      reason: 'generic',
    });
    expect(mockEventPublish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'provider:recovery-probe',
      agentId: 'cursor-agent',
      success: false,
    }));
  });

  it('executes one Type B iteration while holding the sole half-open probe slot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'));
    await agentManager.init();

    circuitBreakerRegistry.recordFailure('aider', 'transient provider failure', {
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    expect(circuitBreakerRegistry.getSnapshot('aider').state).toBe('open');
    vi.advanceTimersByTime(50);

    const result = await agentManager.executeTask('aider', 'run one smoke iteration', {
      projectDir: '/dummy/project',
    });

    expect(result).toMatchObject({
      success: true,
      output: 'mocked output',
      iterations: 1,
    });
    expect(mockExeca).toHaveBeenCalledWith(
      'aider',
      expect.any(Array),
      expect.objectContaining({ cwd: '/dummy/project' }),
    );
    expect(circuitBreakerRegistry.getSnapshot('aider').state).toBe('closed');
  });

  it('runs Type C agent-tools while rejecting a second task that lacks the held probe slot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'));
    await agentManager.init();

    let resolveFirstCompletion!: (value: unknown) => void;
    let markFirstRequestStarted!: () => void;
    const firstCompletion = new Promise<unknown>((resolve) => {
      resolveFirstCompletion = resolve;
    });
    const firstRequestStarted = new Promise<void>((resolve) => {
      markFirstRequestStarted = resolve;
    });
    mockChatCreate
      .mockImplementationOnce(() => {
        markFirstRequestStarted();
        return firstCompletion;
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'type-c completed' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

    circuitBreakerRegistry.recordFailure('api-tools', 'transient provider failure', {
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    vi.advanceTimersByTime(50);

    const firstTask = agentManager.executeTask('api-tools', 'use one tool', {
      projectDir: '/tmp',
    });
    await firstRequestStarted;

    const rejectedTask = await agentManager.executeTask('api-tools', 'second probe');
    expect(rejectedTask).toMatchObject({
      success: false,
      iterations: 0,
      error: 'provider_unavailable: api-tools (half-open/generic)',
    });

    resolveFirstCompletion({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'tool-call-1',
            type: 'function',
            function: {
              name: 'listFiles',
              arguments: JSON.stringify({ path: '/tmp' }),
            },
          }],
        },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    await expect(firstTask).resolves.toMatchObject({
      success: true,
      output: 'type-c completed',
      iterations: 2,
      toolCalls: 1,
    });
    expect(mockEventPublish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'action:listFiles',
      agentId: 'api-tools',
    }));
    expect(circuitBreakerRegistry.getSnapshot('api-tools').state).toBe('closed');
  });

  it('builds a task-scoped PathGuard for an explicit projectDir', async () => {
    await agentManager.init();
    const projectDir = mkdtempSync(join(process.cwd(), '.tmp-nco-task-project-'));
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({ name: 'nova-sandbox-fixture' }),
      'utf8',
    );
    let secondRequest: any;
    mockChatCreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'read-project-package',
              type: 'function',
              function: {
                name: 'readFile',
                arguments: JSON.stringify({ path: 'package.json' }),
              },
            }],
          },
        }],
      })
      .mockImplementationOnce((request: any) => {
        secondRequest = request;
        return Promise.resolve({
          choices: [{ message: { content: 'project inspected' } }],
        });
      });

    try {
      await expect(
        agentManager.executeTask('api-tools', 'inspect the selected project', { projectDir }),
      ).resolves.toMatchObject({
        success: true,
        output: 'project inspected',
        toolCalls: 1,
      });
      expect(JSON.stringify(secondRequest?.messages)).toContain('nova-sandbox-fixture');
      expect(JSON.stringify(secondRequest?.messages)).not.toContain('PathGuard');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

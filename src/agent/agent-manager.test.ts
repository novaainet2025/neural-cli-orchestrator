import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExeca, loadEnabledProviders, env, mockProviders } = vi.hoisted(() => {
  const providers = [
    {
      id: 'aider',
      role: 'execution',
      type: 'orchestrated',
      env: {} as Record<string, string>,
    },
    {
      id: 'claude-code',
      role: 'management',
      type: 'native',
      command: 'claude',
      args: ['--test-flag'],
      env: { SOME_VAR: 'val' } as Record<string, string>,
    }
  ];
  return {
    mockProviders: providers,
    loadEnabledProviders: vi.fn(() => providers),
    env: { PROJECT_DIR: '/dummy/project' },
    mockExeca: vi.fn(async (cmd: string, args: string[], opts: any) => {
      return { stdout: 'mocked output', stderr: '', exitCode: 0 };
    }),
  };
});

vi.mock('../utils/config.js', () => ({
  loadEnabledProviders,
  env,
  getApiKeys: (envVar: string, delimiter = ',') => {
    const raw = process.env[envVar] || '';
    return raw.split(delimiter).map(k => k.trim()).filter(Boolean);
  },
}));

vi.mock('execa', () => ({
  execa: mockExeca,
}));

vi.mock('../security/sandbox-manager.js', () => ({
  createSandbox: () => ({
    getTimeout: () => 5000,
    canExecute: () => true,
    recordSuccess: vi.fn(),
    circuitBreaker: {
      getState: vi.fn(() => 'closed'),
      recordSuccess: vi.fn(),
    },
  }),
}));

vi.mock('../core/event-bus.js', () => ({
  eventBus: {
    publish: vi.fn(),
  },
}));

vi.mock('../core/shared-state.js', () => ({
  sharedState: {
    setAgentState: vi.fn(),
    heartbeat: vi.fn(),
  },
}));

vi.mock('../core/mem0-service.js', () => ({
  mem0Service: {
    search: vi.fn(async () => []),
    add: vi.fn(),
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

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { agentManager } from './agent-manager.js';

describe('AgentManager', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
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
    expect(args).toContain('PING');
    expect(opts.cwd).not.toBe(env.PROJECT_DIR);
    expect(opts.timeout).toBe(30_000);

    agentManager.destroy();
  });
});

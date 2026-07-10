import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  providerMap,
  completionHandlers,
  eventBusPublish,
  sharedState,
  taskQueue,
  toolExecutorExecute,
  openAiConfigs,
} = vi.hoisted(() => {
  const providers = new Map<string, any>([
    ['mlx', {
      id: 'mlx',
      name: 'MLX',
      enabled: true,
      type: 'api',
      role: 'Coder',
      score: 88,
      model: 'qwen3-30b',
      command: null,
      args: [],
      endpoint: 'http://127.0.0.1:8000/v1',
      apiKeyRef: null,
      keyRotation: null,
      env: {},
      concurrency: 1,
      rateLimitRpm: 20,
      cost: 'free',
      capabilities: ['code'],
      permissions: {},
      persona: { systemPrompt: 'mlx prompt', tone: 'efficient', style: 'practical' },
      healthCheck: {},
      apiConfig: { fallback: { provider: 'ollama' } },
    }],
    ['hermes', {
      id: 'hermes',
      name: 'Hermes',
      enabled: true,
      type: 'api',
      role: 'ToolUser',
      score: 86,
      model: 'hermes-model',
      command: null,
      args: [],
      endpoint: 'http://127.0.0.1:8000/v1',
      apiKeyRef: null,
      keyRotation: null,
      env: {},
      concurrency: 2,
      rateLimitRpm: 20,
      cost: 'free',
      capabilities: ['tool-use'],
      permissions: {},
      persona: { systemPrompt: 'hermes prompt', tone: 'precise', style: 'structured' },
      healthCheck: {},
      apiConfig: { fallback: { provider: 'ollama' } },
    }],
    ['ollama', {
      id: 'ollama',
      name: 'Ollama',
      enabled: true,
      type: 'api',
      role: 'Engineer',
      score: 80,
      model: 'ollama-model',
      command: null,
      args: [],
      endpoint: 'http://localhost:11434/v1',
      apiKeyRef: null,
      env: {},
      concurrency: 2,
      rateLimitRpm: 20,
      cost: 'free',
      capabilities: ['code'],
      permissions: {},
      persona: { systemPrompt: 'ollama prompt', tone: 'efficient', style: 'practical' },
      healthCheck: {},
      apiConfig: { fallback: { provider: 'openrouter' } },
    }],
    ['openrouter', {
      id: 'openrouter',
      name: 'OpenRouter',
      enabled: true,
      type: 'api',
      role: 'Generalist',
      score: 75,
      model: 'openrouter-model',
      command: null,
      args: [],
      endpoint: 'https://openrouter.ai/api/v1',
      apiKeyRef: null,
      env: {},
      concurrency: 2,
      rateLimitRpm: 20,
      cost: 'free',
      capabilities: ['code'],
      permissions: {},
      persona: { systemPrompt: 'openrouter prompt', tone: 'neutral', style: 'plain' },
      healthCheck: {},
    }],
  ]);

  return {
    providerMap: providers,
    completionHandlers: new Map<string, ReturnType<typeof vi.fn>>(),
    eventBusPublish: vi.fn(async () => undefined),
    sharedState: {
      setAgentState: vi.fn(async () => undefined),
      getAllAgentStates: vi.fn(async () => ({})),
    },
    taskQueue: {
      recordActivity: vi.fn(),
      getAbortReason: vi.fn(() => null),
    },
    toolExecutorExecute: vi.fn(async () => ({ ok: true, output: 'tool-output' })),
    openAiConfigs: [] as Array<Record<string, unknown>>,
  };
});

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat: {
      completions: {
        create: (params: unknown) => Promise<unknown>;
      };
    };

    constructor(config: Record<string, unknown>) {
      openAiConfigs.push(config);
      const baseURL = String(config.baseURL ?? '');
      const handler = completionHandlers.get(baseURL);
      if (!handler) {
        throw new Error(`missing completion handler for ${baseURL}`);
      }
      this.chat = {
        completions: {
          create: (params: unknown) => (handler as any)(params),
        },
      };
    }
  },
}));

vi.mock('./agent-tools.js', () => ({
  AgentToolExecutor: class MockAgentToolExecutor {
    async execute(call: unknown) {
      return (toolExecutorExecute as any)(call);
    }
  },
}));

vi.mock('./tool-parser.js', () => ({
  parseToolCalls: vi.fn(() => []),
  extractThinking: vi.fn((text: string) => text),
}));

vi.mock('./nco-orchestration-prompt.js', () => ({
  buildApiAgentSystemPrompt: vi.fn((base: string) => base),
  buildCompactSystemPrompt: vi.fn((base: string) => base),
  getNcoOpenAiTools: vi.fn(() => []),
}));

vi.mock('../utils/config.js', () => ({
  getApiKeys: vi.fn(() => []),
  getProvider: vi.fn((id: string) => providerMap.get(id)),
}));

vi.mock('../core/event-bus.js', () => ({
  eventBus: { publish: eventBusPublish },
}));

vi.mock('../core/shared-state.js', () => ({
  sharedState,
}));

vi.mock('../core/task-queue.js', () => ({
  taskQueue,
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
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { ApiExecutor, isRetryableHttpError } from './api-executor.js';

describe('ApiExecutor', () => {
  const sandbox = {
    canExecute: () => true,
    getTimeout: () => 360_000,
    getApiTimeout: () => 300_000,
  } as any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    completionHandlers.clear();
    openAiConfigs.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries 429 responses on the same provider', async () => {
    const handler = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'retry-ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    completionHandlers.set('http://127.0.0.1:8000/v1', handler);

    const executor = new ApiExecutor(providerMap.get('hermes'), sandbox);
    const promise = executor.run('task-1', 'prompt');

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.output).toBe('retry-ok');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('falls back from hermes to ollama when the primary provider fails', async () => {
    completionHandlers.set(
      'http://127.0.0.1:8000/v1',
      vi.fn().mockRejectedValue(new Error('Connection error')),
    );
    completionHandlers.set(
      'http://localhost:11434/v1',
      vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'ollama-ok' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
    );

    const executor = new ApiExecutor(providerMap.get('hermes'), sandbox);
    const result = await executor.run('task-2', 'prompt');

    expect(result.output).toBe('ollama-ok');
    expect(eventBusPublish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'system:fallback',
      from: 'hermes',
      to: 'ollama',
      reason: 'Connection error',
    }));
    expect(openAiConfigs.map(cfg => cfg.baseURL)).toEqual([
      'http://127.0.0.1:8000/v1',
      'http://localhost:11434/v1',
    ]);
  });

  it('resolves mlx aliases before sending the model name', async () => {
    const handler = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'mlx-ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    completionHandlers.set('http://127.0.0.1:8000/v1', handler);

    const executor = new ApiExecutor(providerMap.get('mlx'), sandbox);
    const result = await executor.run('task-3', 'prompt');

    expect(result.model).toBe('/Users/nova-ai/project/LM-models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit');
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      model: '/Users/nova-ai/project/LM-models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit',
      temperature: 0.5,
      repetition_penalty: 1,
    }));
  });

  it('classifies 408 and 429 as retryable HTTP errors', () => {
    expect(isRetryableHttpError({ status: 408 })).toBe(true);
    expect(isRetryableHttpError({ status: 429 })).toBe(true);
    expect(isRetryableHttpError({ status: 500 })).toBe(false);
  });
});

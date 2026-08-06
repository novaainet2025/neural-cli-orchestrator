import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { handleTool, listToolsWithAcquisitions } from './server.js';

const STATIC_TOOL_PARAMS = {
  nco_task: ['ai', 'prompt'],
  nco_parallel: ['prompt', 'providers'],
  nco_discussion: ['prompt', 'providers', 'maxRounds'],
  nco_consensus: ['prompt', 'providers'],
  nco_hive: ['prompt'],
  nco_conductor: ['prompt'],
  nco_commander: ['prompt', 'projectDir'],
  nco_broadcast: ['message'],
  nco_status: [],
  nco_providers: [],
  nco_daemons: [],
  nco_health: [],
  nco_rate_limits: [],
  nco_queue_metrics: [],
  nco_list_sessions: [],
  nco_get_session: ['sessionId'],
  nco_session_messages: ['sessionId'],
  nco_get_task: ['taskId'],
  nco_list_tasks: [],
  nco_start: [],
  nco_stop: [],
  nco_verify: [],
  nco_agent_start: ['prompt', 'provider'],
  nco_agent_status: ['sessionId'],
  nco_agent_abort: ['sessionId'],
  nco_agent_approve: ['sessionId'],
  nco_agent_reject: ['sessionId'],
  nco_agent_sessions: [],
  nco_mesh_sessions: [],
  nco_mesh_summary: [],
  nco_mesh_send: ['content', 'toSessionId'],
  nco_natural: ['query'],
  nco_my_invocations: [],
  nco_invocations: ['limit'],
  nco_ollama_debug: ['action'],
  nco_memory_add: ['agentId', 'content'],
  nco_memory_search: ['agentId', 'query', 'k'],
  nco_memory_list: ['agentId'],
  nco_memory_stats: ['agentId'],
  nco_memory_rebuild: ['agentId'],
  nco_memory_consolidate: ['agentId'],
  nco_evolver_stats: ['agentId'],
} as const satisfies Record<string, readonly string[]>;

const STATIC_TOOL_REQUIRED = {
  nco_task: ['prompt'],
  nco_parallel: ['prompt'],
  nco_discussion: ['prompt'],
  nco_consensus: ['prompt'],
  nco_hive: ['prompt'],
  nco_conductor: ['prompt'],
  nco_commander: ['prompt'],
  nco_broadcast: ['message'],
  nco_get_session: ['sessionId'],
  nco_session_messages: ['sessionId'],
  nco_get_task: ['taskId'],
  nco_agent_start: ['prompt'],
  nco_agent_status: ['sessionId'],
  nco_agent_abort: ['sessionId'],
  nco_agent_approve: ['sessionId'],
  nco_agent_reject: ['sessionId'],
  nco_mesh_send: ['content'],
  nco_natural: ['query'],
  nco_memory_add: ['agentId', 'content'],
  nco_memory_search: ['agentId', 'query'],
  nco_memory_list: ['agentId'],
  nco_memory_stats: ['agentId'],
  nco_memory_rebuild: ['agentId'],
  nco_evolver_stats: ['agentId'],
} as const satisfies Partial<Record<keyof typeof STATIC_TOOL_PARAMS, readonly string[]>>;

function withAllowedOllamaAdmission(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/api/rate-limits/admission/ollama')) {
      return new Response(JSON.stringify({
        allowed: true,
        status: 'available',
        resetAt: null,
      }), { status: 200 });
    }
    return fetchImpl(input, init);
  }) as typeof fetch;
}

describe('static MCP tool contracts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('lists exactly 42 unique static tools with their declared string schemas', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).pathname).toBe('/api/mcp/dynamic-tools');
      return new Response(JSON.stringify({ tools: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tools = await listToolsWithAcquisitions();
    const expectedNames = Object.keys(STATIC_TOOL_PARAMS);
    const actualNames = tools.map(tool => tool.name);

    expect(expectedNames).toHaveLength(42);
    expect(actualNames).toEqual(expectedNames);
    expect(new Set(actualNames).size).toBe(42);
    for (const tool of tools) {
      const expectedParams = STATIC_TOOL_PARAMS[tool.name as keyof typeof STATIC_TOOL_PARAMS];
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
      expect(Object.keys(tool.inputSchema.properties)).toEqual(expectedParams);
      expect(Object.values(tool.inputSchema.properties)).toEqual(
        Object.values(tool.inputSchema.properties).map(() => ({ type: 'string' })),
      );
      const required = STATIC_TOOL_REQUIRED[tool.name as keyof typeof STATIC_TOOL_REQUIRED];
      expect(tool.inputSchema.required).toEqual(required);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('describes system and natural-language tools without claiming unimplemented behavior', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => (
      new Response(JSON.stringify({ tools: [] }), { status: 200 })
    )));

    const byName = new Map((await listToolsWithAcquisitions()).map(tool => [tool.name, tool]));

    expect(byName.get('nco_start')?.description).toContain('starts no provider or backend process');
    expect(byName.get('nco_stop')?.description).toContain('stops no provider or backend process');
    expect(byName.get('nco_verify')?.description).toContain('does not run config validation');
    expect(byName.get('nco_natural')?.description).toContain('does not execute the suggested action');
  });

  it.each([
    ['nco_start', '/api/daemons/start-all', 'POST'],
    ['nco_stop', '/api/daemons/stop-all', 'POST'],
    ['nco_verify', '/health', 'GET'],
  ] as const)('routes %s exactly as its hardened contract states', async (toolName, path, method) => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe(path);
      expect(init?.method ?? 'GET').toBe(method);
      if (method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({});
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(JSON.parse(await handleTool(toolName, {}))).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('routes nco_natural as parse-only and forwards only the documented query', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/nlp/intent');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ query: 'inspect this intent' });
      return new Response(JSON.stringify({
        intent: { primaryAction: { tool: 'searchCode', action: 'execute' } },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = JSON.parse(await handleTool('nco_natural', {
      query: 'inspect this intent',
      context: 'must not be advertised or forwarded',
    }));

    expect(result.intent.primaryAction.tool).toBe('searchCode');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('routes nco_hive to the dedicated Hive endpoint with the exact POST body', async () => {
    vi.stubEnv('NCO_PROJECT_DIR', '/private/tmp/nco-mcp-project-dir-that-does-not-exist');
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/hive');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual({
        prompt: 'hive contract test',
        projectDir: process.cwd(),
      });
      return new Response(JSON.stringify({
        sessionId: 'hive-session-1',
        status: 'started',
        mode: 'hive',
      }), { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = JSON.parse(await handleTool('nco_hive', { prompt: 'hive contract test' }));

    expect(result).toEqual({
      sessionId: 'hive-session-1',
      status: 'started',
      mode: 'hive',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      tool: 'nco_parallel',
      path: '/api/realtime/parallel',
      args: { prompt: 'parallel workspace', providers: 'codex,ollama' },
      payload: { prompt: 'parallel workspace', providers: ['codex', 'ollama'] },
    },
    {
      tool: 'nco_discussion',
      path: '/api/realtime/discussion',
      args: { prompt: 'discussion workspace', providers: 'codex,ollama', maxRounds: '4' },
      payload: { prompt: 'discussion workspace', providers: ['codex', 'ollama'], maxRounds: 4 },
    },
    {
      tool: 'nco_consensus',
      path: '/api/realtime/consensus',
      args: { prompt: 'consensus workspace', providers: 'codex,ollama' },
      payload: { prompt: 'consensus workspace', providers: ['codex', 'ollama'] },
    },
  ])('sends the top-level workspace required by $tool', async ({ tool, path, args, payload }) => {
    vi.stubEnv('NCO_PROJECT_DIR', process.cwd());
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe(path);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        ...payload,
        projectDir: process.cwd(),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(JSON.parse(await handleTool(tool, args))).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing nco_task metadata workspace and caller contract', async () => {
    vi.stubEnv('NCO_PROJECT_DIR', process.cwd());
    vi.stubEnv('NCO_SESSION_ID', 'metadata-session');
    vi.stubEnv('NCO_NAME', 'metadata-agent');
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/task');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        ai: 'codex',
        prompt: 'task workspace',
        callerSessionId: 'metadata-session',
        callerAgentId: 'metadata-agent',
        metadata: { projectDir: process.cwd() },
      });
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(JSON.parse(await handleTool('nco_task', {
      ai: 'codex',
      prompt: 'task workspace',
    }))).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends conductor workspace in metadata and preserves its supported caller correlation', async () => {
    vi.stubEnv('NCO_PROJECT_DIR', process.cwd());
    vi.stubEnv('NCO_SESSION_ID', 'conductor-session');
    vi.stubEnv('NCO_NAME', 'conductor-agent');
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/conductor');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        prompt: 'conductor workspace',
        callerAgentId: 'conductor-agent',
        metadata: {
          projectDir: process.cwd(),
          callerSessionId: 'conductor-session',
          callerAgentId: 'conductor-agent',
        },
      });
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(JSON.parse(await handleTool('nco_conductor', {
      prompt: 'conductor workspace',
    }))).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends Commander workspace and uses the bounded multi-layer timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/commander');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        prompt: 'commander workspace',
        projectDir: process.cwd(),
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ status: 'completed' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(JSON.parse(await handleTool('nco_commander', {
      prompt: 'commander workspace',
      projectDir: process.cwd(),
    }))).toEqual({ status: 'completed' });
    expect(timeoutSpy).toHaveBeenCalledWith(55_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('mcp acquisition overlay', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads acquired skills over the NCO API for tools/list', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/api/mcp/dynamic-tools');
      return new Response(JSON.stringify({
        tools: [{ name: 'acquired_test_tool_overlay', description: 'Overlay test tool' }],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const tools = await listToolsWithAcquisitions();
    expect(tools.some(tool => tool.name === 'acquired_test_tool_overlay')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('delegates dynamic tools/call execution to the NCO API', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/mcp/dynamic-tools/execute') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          tool: 'acquired_test_tool_fallback',
          output: 'dynamic-complete',
          quality: 80,
          steps: 1,
        }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = await handleTool('acquired_test_tool_fallback', { prompt: 'run this' });

    expect(JSON.parse(result)).toMatchObject({
      tool: 'acquired_test_tool_fallback',
      output: 'dynamic-complete',
      steps: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps static tools available when NCO is offline', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
      throw new Error('offline');
    }));

    const tools = await listToolsWithAcquisitions();
    expect(tools.some(tool => tool.name === 'nco_health')).toBe(true);
    expect(tools.some(tool => tool.name.startsWith('acquired_'))).toBe(false);
  });

  // **소스 저장소 안에서만 실행되는 가드다.** 배포된 dist 만 있는 환경에는 `.ts` 원문이
  // 없어 구조적으로 통과가 불가능하다(kangnote 실측 2026-08-07: 활성본 전량 실행 시
  // 이 두 건이 ENOENT 로 남는 유일한 실패였다).
  //
  // 하드 실패보다 **명시적 스킵**이 낫다 — 실패로 남으면 진짜 회귀와 구분이 안 된다.
  // 다만 조용한 스킵은 가드를 약하게 만드므로, 소스가 있는 환경(개발기·CI)에서는
  // 그대로 전력으로 돈다. 근본 해결은 dist 에 테스트를 넣지 않거나(A),
  // 빌드 시점 매니페스트를 함께 배포해 그것을 검사하는 것(C)이다.
  const MCP_SOURCE = new URL('./server.ts', import.meta.url);
  it.skipIf(!existsSync(MCP_SOURCE))('keeps the stdio MCP process free of direct SQLite-backed imports', () => {
    const source = readFileSync(MCP_SOURCE, 'utf8');
    expect(source).not.toContain("storage/database");
    expect(source).not.toContain("core/acquisition-registry");
    expect(source).not.toContain("core/dynamic-skill-engine");
  });
});

describe('nco_ollama_debug direct Ollama fallback', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('proxy reachable: keeps existing /debug/status shape', async () => {
    vi.stubEnv('OLLAMA_PROXY_URL', 'http://localhost:4100');
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://localhost:4100/debug/status');
      return new Response(JSON.stringify({ ok: true, models: ['qwen3:14b'], proxy_version: 'p' }), { status: 200 });
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'status' }));

    expect(result).toEqual({ ok: true, models: ['qwen3:14b'], proxy_version: 'p' });
    expect(result.via).toBeUndefined();
    expect(result.proxy).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('proxy reachable: keeps existing errors projection', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://localhost:4100/debug/status');
      return new Response(JSON.stringify({
        errors: { recent: [{ type: 'upstream', message: 'transient' }], by_type: { upstream: 1 } },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'errors' }));

    expect(result).toEqual({
      recent_errors: [{ type: 'upstream', message: 'transient' }],
      by_type: { upstream: 1 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('proxy reachable: keeps existing inference response shape', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://localhost:4100/v1/messages');
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'test' }));

    expect(result).toEqual({ ok: true, response: 'OK' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('test: active Ollama DB limit blocks both proxy and direct inference fetches', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/api/rate-limits/admission/ollama');
      return new Response(JSON.stringify({
        allowed: false,
        status: 'active-rate-limit',
        resetAt: '2099-01-01T00:00:00.000Z',
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'test' }));

    expect(result).toMatchObject({
      ok: false,
      action: 'test',
      via: 'gated',
      provider: 'ollama',
      admission: { allowed: false, status: 'active-rate-limit' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('/v1/messages');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('/v1/chat/completions');
  });

  it.each([
    ['offline', async () => { throw new Error('NCO admission API offline'); }],
    ['malformed', async () => new Response(JSON.stringify({ allowed: true, status: 'available' }), { status: 200 })],
  ])('test: fails closed when the NCO admission API is %s', async (_case, admissionReply) => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/api/rate-limits/admission/ollama');
      return admissionReply();
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'test' }));

    expect(result).toEqual({
      ok: false,
      action: 'test',
      via: 'gated',
      error: 'provider_unavailable: ollama (gated/admission-state-unavailable)',
      provider: 'ollama',
      admission: { allowed: false, status: 'state-unavailable', resetAt: null },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([input]) => {
      const url = String(input);
      return url.includes('/v1/messages') || url.includes('/v1/chat/completions');
    })).toBe(false);
  });

  it('test: rechecks admission and blocks direct fallback when Ollama becomes limited after proxy failure', async () => {
    vi.stubEnv('OLLAMA_DEBUG_MODEL', 'qwen3:14b');
    let admissionChecks = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/rate-limits/admission/ollama')) {
        admissionChecks++;
        return new Response(JSON.stringify(admissionChecks === 1
          ? { allowed: true, status: 'available', resetAt: null }
          : { allowed: false, status: 'active-rate-limit', resetAt: '2099-01-01T00:00:00.000Z' }), { status: 200 });
      }
      if (url.endsWith('/v1/messages')) throw new Error('proxy down');
      if (url.endsWith('/v1/chat/completions')) throw new Error('direct inference must remain blocked');
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'test' }));

    expect(result).toMatchObject({
      ok: false,
      via: 'gated',
      provider: 'ollama',
      admission: { allowed: false, status: 'active-rate-limit' },
    });
    expect(admissionChecks).toBe(2);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/v1/chat/completions'))).toBe(false);
  });

  it('proxy reachable: keeps existing recover response shape', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://localhost:4100/debug/recover');
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ ok: true, recovered: ['circuit-breaker'] }), { status: 200 });
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'recover' }));

    expect(result).toEqual({ ok: true, recovered: ['circuit-breaker'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clamps direct inference timeout configuration without changing request semantics', async () => {
    vi.stubEnv('OLLAMA_DEBUG_MODEL', 'qwen3:14b');
    vi.stubEnv('OLLAMA_DEBUG_TIMEOUT_MS', '999999');
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/messages')) throw new Error('proxy down');
      if (url.endsWith('/v1/chat/completions')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'test' }));

    expect(result.ok).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledWith(55_000);
    expect(timeoutSpy).toHaveBeenCalledWith(50_000);
    timeoutSpy.mockRestore();
  });

  it('proxy down + Ollama up: status falls back to direct /api/tags without top-level error', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434/v1/');
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/debug/status')) throw new Error('ECONNREFUSED 4100');
      if (url === 'http://localhost:11434/api/tags') {
        return new Response(JSON.stringify({ models: [{ name: 'qwen3:30b-a3b' }, { name: 'nomic-embed-text' }] }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'status' }));

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.via).toBe('direct');
    expect(result.models).toEqual(['qwen3:30b-a3b', 'nomic-embed-text']);
    expect(result.proxy.reachable).toBe(false);
    expect(result.proxy.error).toContain('ECONNREFUSED');
    // OLLAMA_BASE_URL의 후행 /v1이 중복되지 않도록 정규화
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://localhost:11434/api/tags');
  });

  it('keeps OLLAMA_BASE_URL precedence when OLLAMA_HOST is also configured', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'https://ollama.internal/v1');
    vi.stubEnv('OLLAMA_HOST', '127.0.0.1');
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/debug/status')) throw new Error('proxy down');
      if (url === 'https://ollama.internal/api/tags') {
        return new Response(JSON.stringify({ models: [{ name: 'qwen3:14b' }] }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'status' }));

    expect(result.ok).toBe(true);
    expect(result.direct_url).toBe('https://ollama.internal');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('test: direct /v1/chat/completions succeeds when proxy is down', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434/v1');
    vi.stubEnv('OLLAMA_DEBUG_MODEL', 'qwen3:14b');
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/messages')) throw new Error('proxy down');
      if (url === 'http://localhost:11434/v1/chat/completions') {
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body));
        expect(body.messages[0].content).toBe('Reply with exactly OK');
        expect(body.max_tokens).toBe(128);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'test' }));

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.response).toBe('OK');
    expect(result.inference).toEqual({ response_kind: 'content', complete: true });
    expect(result.via).toBe('direct');
    expect(result.proxy.reachable).toBe(false);
  });

  it('test: preserves a non-JSON direct HTTP failure as structured status evidence', async () => {
    vi.stubEnv('OLLAMA_DEBUG_MODEL', 'qwen3:14b');
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/messages')) throw new Error('proxy down');
      if (url.endsWith('/v1/chat/completions')) {
        return new Response('<html>upstream unavailable</html>', {
          status: 503,
          headers: { 'content-type': 'text/html' },
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'test' }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 503');
    expect(result.ollama).toMatchObject({ reachable: true, status: 503 });
    expect(result.ollama.error).toBe('Ollama /v1/chat/completions returned HTTP 503');
  });

  it('test: treats reasoning-only output as partial but successful inference evidence', async () => {
    vi.stubEnv('OLLAMA_DEBUG_MODEL', 'qwen3:14b');
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/messages')) throw new Error('proxy down');
      if (url.endsWith('/v1/chat/completions')) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: '', reasoning: 'still thinking' }, finish_reason: 'length' }],
        }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'test' }));

    expect(result.ok).toBe(true);
    expect(result.response).toBe('still thinking');
    expect(result.partial).toBe(true);
    expect(result.severity).toBe('warning');
    expect(result.inference).toEqual({
      response_kind: 'reasoning',
      complete: false,
      finish_reason: 'length',
    });
  });

  it('test: rejects HTTP 200 when Ollama returns neither content nor reasoning', async () => {
    vi.stubEnv('OLLAMA_DEBUG_MODEL', 'qwen3:14b');
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/messages')) throw new Error('proxy down');
      if (url.endsWith('/v1/chat/completions')) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: '' }, finish_reason: 'length' }],
        }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'test' }));

    expect(result.ok).toBe(false);
    expect(result.ollama).toMatchObject({ reachable: true, status: 200 });
    expect(result.ollama.error).toContain('neither assistant content nor reasoning');
    expect(result.ollama.error).toContain('finish_reason: length');
  });

  it('redacts URL user-info from direct and proxy diagnostic output', async () => {
    vi.stubEnv('OLLAMA_PROXY_URL', 'http://proxy-user:proxy-pass@localhost:4100');
    vi.stubEnv('OLLAMA_BASE_URL', 'http://ollama-user:ollama-pass@localhost:11434/v1');
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('@localhost:4100/debug/status')) {
        throw new Error(`fetch failed for ${url}`);
      }
      if (url === 'http://ollama-user:ollama-pass@localhost:11434/api/tags') {
        return new Response(JSON.stringify({ models: [{ name: 'qwen3:14b' }] }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'status' }));
    const serialized = JSON.stringify(result);

    expect(result.ok).toBe(true);
    expect(result.direct_url).toBe('http://localhost:11434');
    expect(result.proxy.configured).toBe('http://localhost:4100');
    expect(result.proxy.error).toContain('http://[redacted]@localhost:4100');
    expect(serialized).not.toContain('ollama-user');
    expect(serialized).not.toContain('ollama-pass');
    expect(serialized).not.toContain('proxy-user');
    expect(serialized).not.toContain('proxy-pass');
  });

  it('errors: proxy down + direct healthy reports proxy absence without top-level error', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://127.0.0.1:11434');
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/debug/status')) throw new Error('proxy down');
      if (url === 'http://127.0.0.1:11434/api/tags') {
        return new Response(JSON.stringify({ models: [{ name: 'qwen3:14b' }] }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'errors' }));

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.recent_errors).toEqual([]);
    expect(result.by_type).toEqual({});
    expect(result.error_history_available).toBe(false);
    expect(result.note).toContain('Anthropic proxy unavailable');
    expect(result.proxy.reachable).toBe(false);
  });

  it('recover: proxy down + direct healthy is a read-only health check (noop), no top-level error', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/debug/recover')) throw new Error('proxy down');
      if (url === 'http://localhost:11434/api/tags') {
        return new Response(JSON.stringify({ models: [{ name: 'qwen3:14b' }] }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'recover' }));

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.recovery).toEqual({ performed: false, mode: 'noop', read_only: true });
    expect(result.note).toContain('noop');
    expect(result.note.toLowerCase()).toContain('not restarted');
    expect(result.proxy.reachable).toBe(false);
  });

  it('proxy and Ollama both down: explicit top-level error', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const statusResult = JSON.parse(await handleTool('nco_ollama_debug', { action: 'status' }));
    expect(statusResult.ok).toBe(false);
    expect(statusResult.error).toContain('failed');
    expect(statusResult.error).toContain('direct Ollama');
    expect(statusResult.proxy.error).toContain('ECONNREFUSED');
    expect(statusResult.ollama.error).toContain('ECONNREFUSED');

    const testResult = JSON.parse(await handleTool('nco_ollama_debug', { action: 'test' }));
    expect(testResult.ok).toBe(false);
    expect(testResult.error).toContain('failed');
    expect(testResult.error).toContain('direct Ollama');
    expect(testResult.proxy.error).toContain('ECONNREFUSED');
    expect(testResult.ollama.error).toContain('ECONNREFUSED');
  });

  it('treats non-2xx proxy and direct responses as explicit failures', async () => {
    vi.stubEnv('OLLAMA_HOST', '127.0.0.1');
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'http://localhost:4100/debug/status') {
        return new Response(JSON.stringify({ error: 'proxy unavailable' }), { status: 503 });
      }
      if (url === 'http://127.0.0.1:11434/api/tags') {
        return new Response(JSON.stringify({ error: 'ollama unavailable' }), { status: 503 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'status' }));

    expect(result.error).toContain('Anthropic proxy failed');
    expect(result.error).toContain('direct Ollama failed');
    expect(result.error).toContain('HTTP 503');
    expect(result.proxy).toMatchObject({ reachable: true, status: 503 });
    expect(result.ollama).toMatchObject({ reachable: true, status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps proxy HTTP failure evidence when direct Ollama is healthy', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'http://localhost:4100/debug/status') {
        return new Response('proxy unavailable', { status: 503 });
      }
      if (url === 'http://localhost:11434/api/tags') {
        return new Response(JSON.stringify({ models: [{ name: 'qwen3:14b' }] }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'status' }));

    expect(result.ok).toBe(true);
    expect(result.via).toBe('direct');
    expect(result.degraded).toBe(true);
    expect(result.severity).toBe('warning');
    expect(result.proxy).toMatchObject({ reachable: true, status: 503 });
    expect(result.proxy.error).toContain('HTTP 503');
  });

  it('ignores malformed model entries instead of selecting [object Object]', async () => {
    vi.stubEnv('OLLAMA_DEBUG_MODEL', '');
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/messages')) throw new Error('proxy down');
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ digest: 'missing-name' }, { name: 'qwen3:14b' }] }), { status: 200 });
      }
      if (url.endsWith('/v1/chat/completions')) {
        expect(JSON.parse(String(init?.body)).model).toBe('qwen3:14b');
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', withAllowedOllamaAdmission(fetchMock));

    const result = JSON.parse(await handleTool('nco_ollama_debug', { action: 'test' }));

    expect(result.ok).toBe(true);
    expect(result.response).toBe('OK');
  });
});

describe('선언된 도구가 전부 라우팅되는가 (AA)', () => {
  // `listToolsWithAcquisitions` 가 광고하는 도구와 `handleTool` 의 case 가 어긋나면,
  // MCP 클라이언트에는 보이는데 호출하면 `Unknown tool` 이 나온다. 목록과 구현이
  // 따로 관리되므로 도구를 추가하며 한쪽만 고치기 쉽다. 그 불일치를 여기서 잡는다.
  //
  // **동적 도구 폴백을 404 로 막아야 의미가 있다.** `handleDynamicTool` 은 백엔드가
  // 404 를 줄 때만 null 을 내고, 그때만 `Unknown tool` 분기에 도달한다. 200 을 주면
  // 어떤 이름이든 정상 응답처럼 보여 **검사가 통째로 무의미해진다**(초판이 그랬다).
  const ARGS: Record<string, unknown> = {
    prompt: 'contract probe', query: 'contract probe', ai: 'codex',
    providers: ['codex', 'agy'], taskId: 't1', sessionId: 's1', agentId: 'codex',
    message: 'probe', content: 'probe', to: 'codex', text: 'probe', id: 'x1',
    topic: 'contract probe', name: 'probe',
  };

  /** 동적 도구 경로만 404, 나머지는 정상 응답. */
  const stubFetch = () => vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input: RequestInfo | URL) => (
    String(input).includes('/api/mcp/dynamic-tools/execute')
      ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      : new Response(JSON.stringify({ ok: true, tools: [] }), { status: 200 })
  )));

  const unknownToolNames = async (names: readonly string[]): Promise<string[]> => {
    const unknown: string[] = [];
    for (const name of names) {
      stubFetch();
      let raw: string;
      try {
        raw = await handleTool(name, ARGS);
      } catch {
        continue;   // 인자 검증 예외는 라우팅 누락이 아니다
      }
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { continue; }
      const error = (parsed as { error?: string })?.error;
      if (typeof error === 'string' && error.startsWith('Unknown tool:')) unknown.push(name);
    }
    return unknown;
  };

  it('없는 도구는 Unknown tool 로 응답한다 — 대조군', () => {
    // 이 대조군이 통과해야 아래 검사가 의미를 갖는다.
    stubFetch();
    return expect(unknownToolNames(['nco_this_tool_does_not_exist']))
      .resolves.toEqual(['nco_this_tool_does_not_exist']);
  });

  it('선언된 모든 도구가 Unknown tool 없이 처리된다', async () => {
    stubFetch();
    const names = (await listToolsWithAcquisitions()).map(tool => tool.name);
    expect(names.length).toBeGreaterThanOrEqual(40);
    expect(await unknownToolNames(names)).toEqual([]);
  });

  it('도구 이름이 중복되지 않는다', async () => {
    stubFetch();
    const names = (await listToolsWithAcquisitions()).map(tool => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

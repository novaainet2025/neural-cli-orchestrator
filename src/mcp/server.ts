/**
 * NCO MCP Server — 26 tools for Claude Code integration
 * Wraps NCO API (localhost:6200) as MCP tools
 */

import { createInterface } from 'readline';
import { fileURLToPath, pathToFileURL } from 'url';
import { acquisitionRegistry } from '../core/acquisition-registry.js';
import { dynamicSkillEngine } from '../core/dynamic-skill-engine.js';

const NCO_API = process.env.NCO_API_URL || 'http://localhost:6200';
const FETCH_TIMEOUT_MS = 30_000;
const DYNAMIC_TASK_POLL_TIMEOUT_MS = 300_000;
const DYNAMIC_POLL_INTERVAL_MS = 250;

async function ncoFetch(path: string, options?: RequestInit): Promise<any> {
  const url = `${NCO_API}${path}`;
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const body = await res.json();
    if (!res.ok) {
      return {
        error: typeof body?.error === 'string' ? body.error : `NCO request failed: ${url}`,
        status: res.status,
        body,
      };
    }
    return body;
  } catch (error) {
    const status = error instanceof Error && error.name === 'TimeoutError' ? 408 : 503;
    return { error: `NCO offline or unreachable: ${url}`, status };
  }
}

async function ncoPost(path: string, body: any): Promise<any> {
  return ncoFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Tool Definitions ─────────────────────────────────
const TOOLS = [
  // Collaboration (6)
  { name: 'nco_task', description: 'Delegate task to a single AI agent', params: ['ai', 'prompt'] },
  { name: 'nco_parallel', description: 'Run task on multiple AIs in parallel', params: ['prompt', 'providers'] },
  { name: 'nco_discussion', description: 'Start multi-AI discussion', params: ['prompt', 'providers', 'maxRounds'] },
  { name: 'nco_consensus', description: 'AI consensus mode with voting', params: ['prompt', 'providers'] },
  { name: 'nco_hive', description: 'Hive mode — all 9 AIs as one', params: ['prompt'] },
  { name: 'nco_conductor', description: 'Smart auto-dispatch — analyzes complexity and picks best mode+AI', params: ['prompt'] },
  { name: 'nco_commander', description: 'Commander 4-Layer — Management→Information→Execution→Quality hierarchy', params: ['prompt'] },
  { name: 'nco_broadcast', description: 'Broadcast message to all AIs', params: ['message'] },
  // Status (6)
  { name: 'nco_status', description: 'System health check', params: [] },
  { name: 'nco_providers', description: 'List AI providers', params: [] },
  { name: 'nco_daemons', description: 'Daemon status', params: [] },
  { name: 'nco_health', description: 'Detailed health', params: [] },
  { name: 'nco_rate_limits', description: 'Rate limit status', params: [] },
  { name: 'nco_queue_metrics', description: 'Queue metrics', params: [] },
  // Sessions (3)
  { name: 'nco_list_sessions', description: 'List discussion sessions', params: [] },
  { name: 'nco_get_session', description: 'Get session details', params: ['sessionId'] },
  { name: 'nco_session_messages', description: 'Get session messages', params: ['sessionId'] },
  // Tasks (2)
  { name: 'nco_get_task', description: 'Get task status', params: ['taskId'] },
  { name: 'nco_list_tasks', description: 'List all tasks', params: [] },
  // System (3)
  { name: 'nco_start', description: 'Start NCO system', params: [] },
  { name: 'nco_stop', description: 'Stop NCO system', params: [] },
  { name: 'nco_verify', description: 'Verify NCO config', params: [] },
  // Agent (6)
  { name: 'nco_agent_start', description: 'Start autonomous agent', params: ['prompt', 'provider'] },
  { name: 'nco_agent_status', description: 'Agent session status', params: ['sessionId'] },
  { name: 'nco_agent_abort', description: 'Abort agent session', params: ['sessionId'] },
  { name: 'nco_agent_approve', description: 'Approve agent action', params: ['sessionId'] },
  { name: 'nco_agent_reject', description: 'Reject agent action', params: ['sessionId'] },
  { name: 'nco_agent_sessions', description: 'List agent sessions', params: [] },
  // Mesh (3)
  { name: 'nco_mesh_sessions', description: 'List active CLI sessions in mesh', params: [] },
  { name: 'nco_mesh_summary', description: 'Get work summary of all active CLIs', params: [] },
  { name: 'nco_mesh_send', description: 'Send message to CLI sessions', params: ['content', 'toSessionId'] },
  // Natural Language (1)
  { name: 'nco_natural', description: 'Parse natural language to intent and execute appropriate tool', params: ['query', 'context'] },
  // Invocations (2)
  { name: 'nco_my_invocations', description: '내가 호출한 에이전트들의 현재 상태 조회', params: [] },
  { name: 'nco_invocations', description: '전체 에이전트 호출 현황 조회', params: ['limit'] },
  // Ollama / Anthropic proxy debug (1)
  { name: 'nco_ollama_debug', description: 'Anthropic proxy (4100) debug against Ollama upstream: status|errors|recover|test|recover:*. Requires proxy + OLLAMA_BASE_URL.', params: ['action'] },
  // HNSW Vector Memory (6)
  { name: 'nco_memory_add', description: 'Store a memory with HNSW semantic embedding', params: ['agentId', 'content'] },
  { name: 'nco_memory_search', description: 'Semantic HNSW search across agent memories', params: ['agentId', 'query', 'k'] },
  { name: 'nco_memory_list', description: 'List all memories for an agent', params: ['agentId'] },
  { name: 'nco_memory_stats', description: 'Get agent memory stats (count, semantic%, index)', params: ['agentId'] },
  { name: 'nco_memory_rebuild', description: 'Rebuild HNSW index from SQLite (recovery)', params: ['agentId'] },
  { name: 'nco_memory_consolidate', description: 'Run SCM sleep consolidation (boost+prune)', params: ['agentId'] },
  // AgentEvolver (1)
  { name: 'nco_evolver_stats', description: 'Get agent evolution stats and persona suggestions', params: ['agentId'] },
];

type StaticTool = typeof TOOLS[number];
type McpTool = {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: 'string' }>;
  };
};

function toMcpTool(tool: StaticTool): McpTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map(p => [p, { type: 'string' }])),
    },
  };
}

function toAcquiredMcpTool(tool: { name: string; description: string }): McpTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
      },
    },
  };
}

export function listToolsWithAcquisitions(): McpTool[] {
  const staticTools = TOOLS.map(toMcpTool);
  const staticNames = new Set(staticTools.map(tool => tool.name));
  const acquiredTools = acquisitionRegistry.listAcquiredSkillNames()
    .filter(tool => !staticNames.has(tool.name))
    .map(toAcquiredMcpTool);
  return [...staticTools, ...acquiredTools];
}

function extractDynamicPrompt(args: Record<string, unknown>): string {
  const prompt = args.prompt;
  if (typeof prompt === 'string' && prompt.trim().length > 0) {
    return prompt;
  }
  return JSON.stringify(args);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function executeAgentTask(agentId: string, prompt: string): Promise<string> {
  const created = await ncoPost('/api/task', { ai: agentId, prompt });
  if (!created?.taskId || typeof created.taskId !== 'string') {
    throw new Error(typeof created?.error === 'string' ? created.error : 'dynamic skill task creation failed');
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < DYNAMIC_TASK_POLL_TIMEOUT_MS) {
    const status = await ncoFetch(`/api/tasks/${created.taskId}/status`);
    if (status?.status === 'completed') {
      return typeof status.result === 'string' ? status.result : JSON.stringify(status.result ?? '');
    }
    if (['failed', 'timed_out', 'cancelled'].includes(status?.status)) {
      throw new Error(typeof status?.error === 'string' ? status.error : `dynamic skill task ${status.status}`);
    }
    await sleep(DYNAMIC_POLL_INTERVAL_MS);
  }

  throw new Error(`dynamic skill task timeout: ${created.taskId}`);
}

async function handleDynamicTool(name: string, args: Record<string, unknown>): Promise<string | null> {
  const skill = acquisitionRegistry.listAcquiredSkillNames().find(entry => entry.name === name);
  if (!skill) return null;

  const result = await dynamicSkillEngine.executeSkill(
    skill.id,
    extractDynamicPrompt(args),
    executeAgentTask,
  );

  return JSON.stringify({
    tool: name,
    output: result.output,
    quality: result.quality,
    steps: result.steps,
  });
}

// ─── Tool Handler ─────────────────────────────────────
export async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    // Collaboration
    case 'nco_task': {
      const _sid = process.env.NCO_SESSION_ID || String(process.ppid || process.pid);
      const _aid = process.env.NCO_NAME || 'claude-code';
      return JSON.stringify(await ncoPost('/api/task', { ai: args.ai, prompt: args.prompt, callerSessionId: _sid, callerAgentId: _aid }));
    }
    case 'nco_parallel': return JSON.stringify(await ncoPost('/api/realtime/parallel', { prompt: args.prompt, providers: args.providers }));
    case 'nco_discussion': return JSON.stringify(await ncoPost('/api/realtime/discussion', { prompt: args.prompt, providers: args.providers, maxRounds: args.maxRounds }));
    case 'nco_consensus': return JSON.stringify(await ncoPost('/api/realtime/consensus', { prompt: args.prompt, providers: args.providers }));
    case 'nco_hive': return JSON.stringify(await ncoPost('/api/realtime/discussion', { prompt: args.prompt, mode: 'hive' }));
    case 'nco_conductor': return JSON.stringify(await ncoPost('/api/conductor', { prompt: args.prompt }));
    case 'nco_commander': return JSON.stringify(await ncoPost('/api/commander', { prompt: args.prompt }));
    case 'nco_broadcast': return JSON.stringify(await ncoPost('/api/chat/messages', { message: args.message, broadcast: true }));
    // Status
    case 'nco_status': return JSON.stringify(await ncoFetch('/health'));
    case 'nco_providers': return JSON.stringify(await ncoFetch('/api/ai-providers'));
    case 'nco_daemons': return JSON.stringify(await ncoFetch('/api/daemons'));
    case 'nco_health': return JSON.stringify(await ncoFetch('/api/health'));
    case 'nco_rate_limits': return JSON.stringify(await ncoFetch('/api/rate-limits/state'));
    case 'nco_queue_metrics': return JSON.stringify(await ncoFetch('/api/queue/metrics'));
    // Sessions
    case 'nco_list_sessions': return JSON.stringify(await ncoFetch('/api/realtime-sessions'));
    case 'nco_get_session': return JSON.stringify(await ncoFetch(`/api/discussions/${args.sessionId}`));
    case 'nco_session_messages': return JSON.stringify(await ncoFetch(`/api/discussions/${args.sessionId}/messages`));
    // Tasks
    case 'nco_get_task': return JSON.stringify(await ncoFetch(`/api/tasks/${args.taskId}`));
    case 'nco_list_tasks': return JSON.stringify(await ncoFetch('/api/tasks'));
    // System
    case 'nco_start': return JSON.stringify(await ncoPost('/api/daemons/start-all', {}));
    case 'nco_stop': return JSON.stringify(await ncoPost('/api/daemons/stop-all', {}));
    case 'nco_verify': return JSON.stringify(await ncoFetch('/health'));
    // Agent
    case 'nco_agent_start': return JSON.stringify(await ncoPost('/api/agent/start', { prompt: args.prompt, provider: args.provider }));
    case 'nco_agent_status': return JSON.stringify(await ncoFetch(`/api/agent/${args.sessionId}/status`));
    case 'nco_agent_abort': return JSON.stringify(await ncoPost(`/api/agent/${args.sessionId}/abort`, {}));
    case 'nco_agent_approve': return JSON.stringify(await ncoPost(`/api/agent/${args.sessionId}/approve`, {}));
    case 'nco_agent_reject': return JSON.stringify(await ncoPost(`/api/agent/${args.sessionId}/reject`, {}));
    case 'nco_agent_sessions': return JSON.stringify(await ncoFetch('/api/agent/sessions'));
    // Mesh
    case 'nco_mesh_sessions': return JSON.stringify(await ncoFetch('/api/mesh/sessions'));
    case 'nco_mesh_summary': return JSON.stringify(await ncoFetch('/api/mesh/summary'));
case 'nco_mesh_send': {
      const mySessionId = process.env.NCO_SESSION_ID || String(process.ppid || process.pid);
      const myName = process.env.NCO_NAME || 'claude-code';
      return JSON.stringify(await ncoPost('/api/mesh/send', { fromSessionId: mySessionId, fromAgent: myName, toSessionId: args.toSessionId || '*', content: args.content }));
    }
    // Natural Language
    case 'nco_natural': return JSON.stringify(await ncoPost('/api/nlp/intent', { query: args.query, context: args.context }));
    // Invocations
    case 'nco_my_invocations': {
      const sessionId = process.env.NCO_SESSION_ID || String(process.ppid || process.pid);
      return JSON.stringify(await ncoFetch(`/api/invocations/session/${encodeURIComponent(sessionId)}`));
    }
    case 'nco_invocations': {
      const limitValue = asOptionalString(args.limit);
      const limit = limitValue ? `?limit=${encodeURIComponent(limitValue)}` : '';
      return JSON.stringify(await ncoFetch(`/api/invocations/overview${limit}`));
    }
    // Ollama / proxy debug
    case 'nco_ollama_debug': {
      const PROXY = process.env.OLLAMA_PROXY_URL || process.env.VLLM_PROXY_URL || 'http://localhost:4100';
      const action = (asOptionalString(args.action) ?? 'status').toLowerCase();
      try {
        if (action === 'status' || action === 'errors') {
          const res = await fetch(`${PROXY}/debug/status`, { signal: AbortSignal.timeout(10_000) });
          const data = await res.json();
          if (action === 'errors') {
            return JSON.stringify({ recent_errors: data.errors?.recent ?? [], by_type: data.errors?.by_type ?? {} });
          }
          return JSON.stringify(data);
        }
        if (action === 'test') {
          const res = await fetch(`${PROXY}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'dummy' },
            body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 30, messages: [{ role: 'user', content: 'Say OK' }] }),
            signal: AbortSignal.timeout(30_000),
          });
          const data = await res.json();
          return JSON.stringify({ ok: res.ok, response: data.content?.[0]?.text ?? data });
        }
        // recover actions: recover | recover:model_refresh | recover:health_check | recover:ctx_refresh | recover:error_clear
        const recoverAction = action.startsWith('recover:') ? action.slice(8) : 'auto';
        const res = await fetch(`${PROXY}/debug/recover`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: recoverAction }),
          signal: AbortSignal.timeout(15_000),
        });
        return JSON.stringify(await res.json());
      } catch (err: any) {
        return JSON.stringify({ error: `Anthropic proxy unreachable at ${PROXY}: ${err.message}` });
      }
    }
    // HNSW Vector Memory
    case 'nco_memory_add': return JSON.stringify(await ncoPost(`/api/memory/${encodeURIComponent(asOptionalString(args.agentId) ?? '')}/add`, { content: args.content }));
    case 'nco_memory_search': return JSON.stringify(await ncoPost(`/api/memory/${encodeURIComponent(asOptionalString(args.agentId) ?? '')}/search`, { query: args.query, k: args.k ? Number(args.k) : 5 }));
    case 'nco_memory_list': return JSON.stringify(await ncoFetch(`/api/memory/${encodeURIComponent(asOptionalString(args.agentId) ?? '')}`));
    case 'nco_memory_stats': return JSON.stringify(await ncoFetch(`/api/memory/${encodeURIComponent(asOptionalString(args.agentId) ?? '')}/stats`));
    case 'nco_memory_rebuild': return JSON.stringify(await ncoPost(`/api/memory/${encodeURIComponent(asOptionalString(args.agentId) ?? '')}/rebuild`, {}));
    case 'nco_memory_consolidate': return JSON.stringify(await ncoPost('/api/memory/consolidate', { agentId: args.agentId }));
    // AgentEvolver
    case 'nco_evolver_stats': return JSON.stringify(await ncoFetch(`/api/evolver/${encodeURIComponent(String(args.agentId ?? ''))}/stats`));
    default: {
      const dynamicResult = await handleDynamicTool(name, args);
      return dynamicResult ?? JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }
}

// ─── Stdio MCP Protocol ──────────────────────────────
// Simple JSON-RPC over stdin/stdout
function send(msg: any) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

export function startStdioServer(): void {
  const rl = createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    try {
      const req = JSON.parse(line);

      if (req.method === 'initialize') {
        send({ jsonrpc: '2.0', id: req.id, result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'nco-mcp-server', version: '1.0.0' },
        }});
      } else if (req.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: req.id, result: {
          tools: listToolsWithAcquisitions(),
        }});
      } else if (req.method === 'tools/call') {
        const result = await handleTool(req.params.name, req.params.arguments || {});
        send({ jsonrpc: '2.0', id: req.id, result: {
          content: [{ type: 'text', text: result }],
        }});
      } else if (req.method === 'notifications/initialized') {
        // No response needed
      } else {
        send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Unknown method: ${req.method}` }});
      }
    } catch (_err: any) {
      // Ignore parse errors on notification lines
    }
  });
}

function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return import.meta.url === pathToFileURL(argv1).href;
}

if (isMainModule()) {
  startStdioServer();
}

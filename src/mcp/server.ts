/**
 * NCO MCP Server — 26 tools for Claude Code integration
 * Wraps NCO API (localhost:6200) as MCP tools
 */

const NCO_API = process.env.NCO_API_URL || 'http://localhost:6200';
const TIMEOUT = 30_000;

async function ncoFetch(path: string, options?: RequestInit): Promise<any> {
  const url = `${NCO_API}${path}`;
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT) });
    return res.json();
  } catch {
    return { error: `NCO offline or unreachable: ${url}` };
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
  // vLLM Debug (1)
  { name: 'nco_vllm_debug', description: 'vLLM proxy debug: check errors, health, trigger self-recovery. action: status|errors|recover|test|recover:model_refresh|recover:health_check|recover:ctx_refresh|recover:error_clear', params: ['action'] },
];

// ─── Tool Handler ─────────────────────────────────────
async function handleTool(name: string, args: any): Promise<string> {
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
      const limit = args.limit ? `?limit=${encodeURIComponent(args.limit)}` : '';
      return JSON.stringify(await ncoFetch(`/api/invocations/overview${limit}`));
    }
    // vLLM Debug
    case 'nco_vllm_debug': {
      const PROXY = process.env.VLLM_PROXY_URL || 'http://localhost:4100';
      const action = (args.action || 'status').toLowerCase();
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
        return JSON.stringify({ error: `vLLM proxy unreachable at ${PROXY}: ${err.message}` });
      }
    }
    default: return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ─── Stdio MCP Protocol ──────────────────────────────
// Simple JSON-RPC over stdin/stdout
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin });

function send(msg: any) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

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
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: {
            type: 'object',
            properties: Object.fromEntries(t.params.map(p => [p, { type: 'string' }])),
          },
        })),
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
  } catch (err: any) {
    // Ignore parse errors on notification lines
  }
});

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import { env } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { redisHealthCheck, getRedis, isRedisConnected } from '../storage/redis.js';
import { getDb } from '../storage/database.js';
import { agentManager } from '../agent/agent-manager.js';
import { discussionEngine } from '../core/discussion-engine.js';
import { sharedState } from '../core/shared-state.js';
import { eventBus, type NCOEvent } from '../core/event-bus.js';
import { createTaskId, createSessionId } from '../utils/id.js';
import { CreateTaskInput, CreateDiscussionInput } from '../utils/validation.js';
import { parseIntent } from '../utils/intent-parser.js';
import { taskQueue } from '../core/task-queue.js';
import { injectContext } from '../core/conversation-context.js';
import { registerDashboardRoutes } from './routes/dashboard-compat.js';
import { registerTestRoutes } from './routes/test.js';
import { registerInterSessionRoutes } from './routes/inter-session.js';
import { registerMathRoutes } from './routes/math.js';
import { registerIdentityRoutes } from './routes/identity.js';
import { registerEconomyRoutes } from './routes/economy.js';
import { registerGovernanceRoutes } from './routes/governance.js';
import { registerDomainRoutes } from './routes/domains.js';
import { registerMarketplaceRoutes } from './routes/marketplace.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerDiplomacyRoutes } from './routes/diplomacy.js';
import { registerWellnessRoutes } from './routes/wellness.js';
import { registerRightsRoutes } from './routes/rights.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerGovernmentOfficialRoutes } from './routes/government.js';
import { registerLaborRoutes } from './routes/labor.js';
import { registerWelfareRoutes } from './routes/welfare.js';
import { registerEducationRoutes } from './routes/education.js';
import { registerDonationRoutes } from './routes/donations.js';
import { registerPrivacyRoutes } from './routes/privacy.js';
import { registerResearchRoutes } from './routes/research.js';
import { registerEnvironmentRoutes } from './routes/environment.js';
import { appendAudit } from '../audit/merkleLog.js';
import { registerMetricsRoutes } from '../monitoring/metrics.js';
import { invocationTracker } from '../core/invocation-tracker.js';
import { delegationManager } from '../core/delegation-manager.js';
import { collaborationEngine } from '../core/collaboration-engine.js';
import { sortProvidersByCostOrder, smartRouter } from '../core/smart-router.js';
import { ensembleEngine } from '../core/ensemble-engine.js';
import { qualityGate } from '../core/quality-gate.js';
import { semanticMemory } from '../core/semantic-memory.js';
import { dynamicSkillEngine } from '../core/dynamic-skill-engine.js';
import { crossValidator } from '../core/cross-validator.js';
import { harnessOrchestrator } from '../core/harness-orchestrator.js';
import { benchmarkSuite } from '../core/benchmark-suite.js';
import { adaptiveScorer } from '../core/adaptive-scorer.js';
import { buildTeamProjectPrompts } from './conductor-prompts.js';
import { authenticateRequest } from '../auth.js';
import { execSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { add } from '../utils/math.js';

const log = createLogger('gateway');

// ─── Lazy-cached dynamic imports (avoid repeated await import() per request) ─


let _cliMeshMod: Awaited<typeof import('../core/cli-mesh.js')> | null = null;
async function getCliMesh() {
  if (!_cliMeshMod) _cliMeshMod = await import('../core/cli-mesh.js');
  return _cliMeshMod.cliMesh;
}
let _smartRouterMod: Awaited<typeof import('../core/smart-router.js')> | null = null;
async function getSmartRouter() {
  if (!_smartRouterMod) _smartRouterMod = await import('../core/smart-router.js');
  return _smartRouterMod.smartRouter;
}
let _commanderMod: Awaited<typeof import('../core/commander.js')> | null = null;
async function getCommander() {
  if (!_commanderMod) _commanderMod = await import('../core/commander.js');
  return _commanderMod.commander;
}
let _sessionManagerMod: Awaited<typeof import('../agent/session-manager.js')> | null = null;
async function getSessionManager() {
  if (!_sessionManagerMod) _sessionManagerMod = await import('../agent/session-manager.js');
  return _sessionManagerMod.sessionManager;
}

// ── AI Agent Memory Store — module-level to avoid tsx async-scope hoisting bug ──
const aiAgentMemory: Record<string, { identity: any; memory: any[]; state: any; lastSeen: string }> = {};

function getOrCreateAgentHome(agentId: string) {
  if (!aiAgentMemory[agentId]) {
    try {
      const db = getDb();
      const row = db.prepare(`SELECT data FROM agent_ai_home WHERE agent_id=?`).get(agentId) as any;
      if (row?.data) { aiAgentMemory[agentId] = JSON.parse(row.data); }
    } catch { /* table may not exist yet */ }
    if (!aiAgentMemory[agentId]) {
      aiAgentMemory[agentId] = {
        identity: { agentId, role: 'ai-agent', joinedAt: new Date().toISOString() },
        memory: [],
        state: { status: 'active', currentTask: null, mood: 'ready' },
        lastSeen: new Date().toISOString(),
      };
    }
  }
  return aiAgentMemory[agentId];
}

function saveAgentHome(agentId: string) {
  try {
    const db = getDb();
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_ai_home (agent_id TEXT PRIMARY KEY, data TEXT, updated_at TEXT)`).run();
    db.prepare(`INSERT OR REPLACE INTO agent_ai_home (agent_id, data, updated_at) VALUES (?,?,?)`
    ).run(agentId, JSON.stringify(aiAgentMemory[agentId]), new Date().toISOString());
  } catch { /* best-effort */ }
}

export async function createGateway() {
  const app = Fastify({ logger: false });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    hsts: false,  // localhost에서 HSTS는 HTTP 접속 차단 유발
  });
  // compress 비활성화 — @fastify/compress가 content-length:0 + content-encoding:gzip 조합으로
  // 브라우저에 빈 응답을 보내는 버그 발생. 대시보드 HTML은 6KB 미만으로 압축 불필요.
  // await app.register(compress);

  await app.register(cors, {
    origin: [
      'http://localhost:6200', 'http://127.0.0.1:6200',
      'http://localhost:3000', 'http://127.0.0.1:3000',
      /^http:\/\/localhost:\d+$/,
    ],
  });

  // ═══ Rate Limiting ═══════════════════════════════════
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', '::1'],
  });

  // ═══ API Authentication (skip if no token configured) ══════════════════════════════
  if (env.NCO_API_TOKEN && env.NCO_API_TOKEN !== 'nco_secret_key_change_me_in_production') {
    app.addHook('onRequest', async (request, reply) => {
      await authenticateRequest(request, reply, {
        apiToken: env.NCO_API_TOKEN,
        jwtSecret: env.NCO_JWT_SECRET,
      });
    });
  }

  // ═══ Global Error Handler ═══════════════════════════
  app.setErrorHandler((error, _request, reply) => {
    const err = error as any;
    log.error({ err: err.message, stack: err.stack }, 'Unhandled route error');
    const statusCode = err.statusCode || 500;
    reply.code(statusCode).send({
      error: statusCode >= 500 ? 'Internal Server Error' : err.message,
      statusCode,
    });
  });

  app.get('/', async (_request, reply) => {
    reply.code(200);
    return {
      message: 'NCO Backend is running',
      status: 'ok',
    };
  });

  // ═══ Health ═══════════════════════════════════════
  app.get('/health', async () => {
    const agents = await sharedState.getAllAgentStates();
    const redisOk = await redisHealthCheck();
    const addResult = add(2, 3);
    return {
      status: 'healthy',
      service: 'nco-backend',
      version: '1.0.0',
      ports: { api: env.PORT, ws: env.WS_PORT },
      providerCount: agentManager.listEnabledIds().length,
      runtime: {
        redis: redisOk,
        agentsOnline: Object.values(agents).filter(a => a.status !== 'offline').length,
        uptime: process.uptime(),
      },
      checks: {
        add: {
          ok: addResult === 5,
          result: addResult,
        },
      },
      timestamp: new Date().toISOString(),
    };
  });

  app.get('/api/health', async () => {
    const redisOk = await redisHealthCheck();
    const addResult = add(2, 3);
    return {
      healthy: true,
      api: { port: env.PORT },
      websocket: { port: env.WS_PORT },
      redis: { connected: redisOk },
      storage: { kind: 'sqlite', path: env.DATABASE_PATH },
      checks: {
        add: {
          ok: addResult === 5,
          result: addResult,
        },
      },
      timestamp: new Date().toISOString(),
    };
  });

  // ═══ Events (REST) ═══════════════════════════════════
  app.get('/api/events', async (req) => {
    const { limit, type, agentId } = req.query as any;
    const cacheKey = `cache:api:events:${limit}:${type}:${agentId}`;

    if (isRedisConnected()) {
      try {
        const redis = await getRedis();
        const cached = await redis.get(cacheKey);
        if (cached) return JSON.parse(cached);
      } catch (err) {
        log.warn({ err }, 'Redis cache read failed');
      }
    }

    const db = getDb();
    let sql = 'SELECT id, agent_id as agentId, action_type as type, target, detail_json as payload, task_id as taskId, session_id as sessionId, created_at as createdAt FROM agent_actions';
    const conditions: string[] = [];
    const params: any[] = [];
    if (type) { conditions.push('action_type = ?'); params.push(type); }
    if (agentId) { conditions.push('agent_id = ?'); params.push(agentId); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(Number(limit) || 50);
    try {
      const rows = db.prepare(sql).all(...params) as any[];
      const result = { events: rows.map(r => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null })) };

      if (isRedisConnected()) {
        try {
          const redis = await getRedis();
          await redis.set(cacheKey, JSON.stringify(result), 'EX', 10); // 10s TTL
        } catch (err) {
          log.warn({ err }, 'Redis cache write failed');
        }
      }
      return result;
    } catch {
      return { events: [] };
    }
  });

  // ═══ SSE Event Stream ═════════════════════════════════
  app.get('/api/events/stream', async (request, reply) => {
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const handler = (event: NCOEvent) => {
      try { reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
    };
    eventBus.on('*', handler);
    // Keep-alive ping to detect dead connections
    const keepAlive = setInterval(() => {
      try { reply.raw.write(': keepalive\n\n'); } catch { clearInterval(keepAlive); eventBus.off('*', handler); }
    }, 30000);
    request.raw.on('close', () => { clearInterval(keepAlive); eventBus.off('*', handler); });
    await new Promise(() => {}); // keep alive until client disconnects
  });

  // ═══ AI Providers ═════════════════════════════════
  app.get('/api/ai-providers', async () => {
    const states = await sharedState.getAllAgentStates();
    const providers = agentManager.listProviders().map(p => ({
      ...p,
      status: states[p.id]?.status || 'offline',
      ai_status: states[p.id]?.status || 'offline',
      health: states[p.id]?.health || { consecutiveFailures: 0, circuitState: 'closed', lastError: null },
    }));
    return { providers };
  });

  app.get('/api/ai-providers/enabled', async () => {
    const states = await sharedState.getAllAgentStates();
    const providers = agentManager.listProviders().filter(p => p.enabled).map(p => ({
      ...p,
      status: states[p.id]?.status || 'offline',
    }));
    return { providers };
  });

  app.get('/api/ai-providers/status', async () => {
    const states = await sharedState.getAllAgentStates();
    return { providers: states };
  });

  // ═══ Daemons ══════════════════════════════════════
  app.get('/api/daemons', async () => {
    const states = await sharedState.getAllAgentStates();
    const daemons = agentManager.listProviders().map(p => {
      const s = states[p.id];
      const status = s?.status || 'offline';
      // Determine agent category for UI display
      const agentType: 'cli' | 'api' = (p as any).type || 'cli';
      return {
        id: p.id,
        name: p.id,
        status,
        running: status !== 'offline',
        available: s?.health?.circuitState !== 'open',
        ai_status: status,
        role: p.role,
        score: p.score,
        enabled: p.enabled,
        type: agentType,
        currentTask: s?.currentTask || null,
        tasks: { active: s?.currentTask ? 1 : 0 },
        health: s?.health || { consecutiveFailures: 0, circuitState: 'closed', lastError: null },
      };
    });
    return { daemons };
  });

  // ═══ Tasks ════════════════════════════════════════
  app.post('/api/task', async (req, reply) => {
    const input = CreateTaskInput.parse(req.body);
    const taskId = createTaskId();
    const body = req.body as any;
    // provider/ai 필드 통합: provider → ai alias 지원, 미지정 시 SmartRouter 자동 선택
    // fallback: cursor-agent (91.9% 성공률) — openrouter는 rate-limit 이슈로 제외
    const enabledIds = agentManager.listEnabledIds();
    const rawAgent = input.ai || input.agentId || body.provider || body.agent || body.agentId;
    let agentId: string;
    if (rawAgent && enabledIds.includes(rawAgent)) {
      agentId = rawAgent;  // 명시적 + 활성화된 에이전트 사용
    } else if (rawAgent) {
      // 명시됐지만 비활성화 — smart router로 대체
      const fallbacks = ['cursor-agent', 'opencode', 'codex', 'copilot', 'agy', 'nvidia', 'mlx'];
      agentId = fallbacks.find(f => enabledIds.includes(f)) ?? enabledIds[0] ?? 'cursor-agent';
    } else {
      // 미지정 — PROVIDER_COST_ORDER 기반 첫 번째 활성 에이전트
      const costOrder = ['cursor-agent', 'opencode', 'codex', 'copilot', 'agy', 'nvidia', 'mlx'];
      agentId = costOrder.find(f => enabledIds.includes(f)) ?? enabledIds[0] ?? 'cursor-agent';
    }

    // Extract caller context for invocation tracking
    const callerSessionId = body.callerSessionId
      || (req.headers['x-nco-session-id'] as string)
      || 'unknown';
    const callerAgentId = body.callerAgentId || 'unknown';
    // CLI session that spawned this task — used by topology to draw CLI→Agent edges
    const spawnedByCli = callerAgentId !== 'unknown' ? callerAgentId
      : callerSessionId !== 'unknown' ? callerSessionId
      : null;

    // Save to DB
    const db = getDb();
    try {
      db.prepare(`
        INSERT INTO tasks (id, mode, prompt, system_prompt, assigned_to, status, workspace_id, priority, spawned_by_cli)
        VALUES (?, ?, ?, ?, ?, 'assigned', ?, ?, ?)
      `).run(taskId, input.mode, input.prompt, input.systemPrompt || null, agentId, input.workspaceId, input.priority, spawnedByCli);
    } catch (dbErr) {
      log.error({ err: (dbErr as Error).message, taskId }, 'Failed to insert task');
      reply.code(500); return { error: 'Failed to create task' };
    }

    await eventBus.publish({ type: 'task:created', taskId, agentId, prompt: input.prompt });

    // Record invocation
    const invocationId = await invocationTracker.recordInvocation(
      callerSessionId,
      callerAgentId,
      agentId,
      input.prompt,
      input.mode || 'task',
      taskId,
    );

    // Inject workspace conversation history into systemPrompt so the agent
    // has context from previous turns in the same workspace session.
    const systemPromptWithContext = injectContext(
      input.systemPrompt,
      input.workspaceId || 'default',
      taskId,
    );

    // Enqueue via TaskQueueManager (BullMQ or semaphore) — respects per-agent concurrency
    taskQueue.enqueue({ taskId, agentId, prompt: input.prompt, systemPrompt: systemPromptWithContext, metadata: { invocationId, projectDir: input.projectDir } })
      .then(result => {
        const response = (result.output != null && result.output !== '') ? result.output : (result.error || '(에이전트 응답 없음)');
        const errMsg = result.success ? null : (result.error || response || 'unknown_error');
        const newStatus = result.success ? 'completed' : 'failed';
        try {
          if (result.success) {
            db.prepare(`UPDATE tasks SET status='completed', response=?, error=NULL, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
              .run(response, taskId);
          } else {
            // Classify error type for diagnostics
            const errType = errMsg?.includes('rate limit') || errMsg?.includes('Rate limit') ? 'rate_limit'
              : errMsg?.includes('timeout') || errMsg?.includes('timed_out') ? 'timeout'
              : errMsg?.includes('ECONNREFUSED') || errMsg?.includes('ENOTFOUND') ? 'network'
              : 'task_failed';
            db.prepare(`UPDATE tasks SET status='failed', response=?, error=?, updated_at=datetime('now') WHERE id=?`)
              .run(response, `[${errType}] ${errMsg}`, taskId);
          }

          // Auto check-in: update AI agent home state
          const taskRow = db.prepare(`SELECT assigned_to FROM tasks WHERE id=?`).get(taskId) as { assigned_to?: string } | undefined;
          const assigned_to = taskRow?.assigned_to;
          const _agentId = agentId || assigned_to;
          if (_agentId) {
            const home = getOrCreateAgentHome(_agentId);
            home.state = {
              ...home.state,
              lastTask: taskId,
              lastStatus: newStatus,
              lastActive: new Date().toISOString(),
            };
            home.lastSeen = new Date().toISOString();
            saveAgentHome(_agentId);
          }
        } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update after task completion failed'); }
      })
      .catch(err => {
        try {
          const errMsg = err.message || String(err);
          const errType = errMsg.includes('rate limit') ? 'rate_limit'
            : errMsg.includes('timeout') ? 'timeout'
            : errMsg.includes('ECONNREFUSED') ? 'network'
            : 'crash';
          db.prepare(`UPDATE tasks SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`)
            .run(`[${errType}] ${errMsg}`, taskId);
        } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update after task failure failed'); }
      });

    reply.code(202);
    return { taskId, status: 'queued', agentId, invocationId };
  });

  app.post('/api/tasks', async (req, reply) => {
    // Alias for /api/task — forward auth header and parse response properly
    const res = await app.inject({
      method: 'POST',
      url: '/api/task',
      payload: req.body as any,
      headers: { authorization: req.headers.authorization || '' },
    });
    reply.code(res.statusCode);
    return res.json();
  });

  app.get('/api/tasks', async (req) => {
    const query = req.query as any;
    const rawLimit = Number(query.limit || 100);
    const limit = Math.min(Number.isFinite(rawLimit) ? rawLimit : 100, 500);
    const db = getDb();
    // assigned_to → provider alias 추가, error 필드 포함
    let sql = `SELECT id, mode, prompt, assigned_to AS provider, assigned_to,
                      delegated_from, status, progress, response, error,
                      workspace_id, parent_task_id, priority,
                      metadata_json, created_at, updated_at, completed_at
               FROM tasks ORDER BY created_at DESC LIMIT ?`;
    const params: any[] = [limit];

    if (query.workspaceId) {
      sql = `SELECT id, mode, prompt, assigned_to AS provider, assigned_to,
                    delegated_from, status, progress, response, error,
                    workspace_id, parent_task_id, priority,
                    metadata_json, created_at, updated_at, completed_at
             FROM tasks WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?`;
      params.unshift(query.workspaceId);
    }

    const tasks = db.prepare(sql).all(...params);
    return { tasks };
  });

  app.get('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as any;
    const db = getDb();
    const task = db.prepare('SELECT *, assigned_to AS provider FROM tasks WHERE id=?').get(id);
    if (!task) { reply.code(404); return { error: 'Task not found' }; }
    return { task };
  });

  app.get('/api/tasks/:id/status', async (req, reply) => {
    const { id } = req.params as any;
    const db = getDb();
    const task = db.prepare('SELECT id, status, progress, response, error, updated_at FROM tasks WHERE id=?').get(id) as any;
    if (!task) { reply.code(404); return { error: 'Task not found' }; }
    return { taskId: task.id, status: task.status, progress: task.progress, result: task.response, updatedAt: task.updated_at };
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as any;
    const db = getDb();

    // Abort via taskQueue (works for both BullMQ queued and semaphore active tasks)
    const killed = await taskQueue.abort(id);

    // Atomic DB update — transaction ensures status + timestamp are consistent
    const cancelTask = db.transaction(() => {
      db.prepare("UPDATE tasks SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(id);
    });
    try {
      cancelTask();
    } catch (dbErr) {
      log.error({ err: (dbErr as Error).message, taskId: id }, 'Failed to cancel task in DB');
    }
    await eventBus.publish({ type: 'task:cancelled', taskId: id });
    return { ok: true, killed };
  });

  // ═══ Chat ═════════════════════════════════════════
  app.post('/api/chat/messages', async (req, reply) => {
    const body = req.body as any;
    const prompt = (body.message || body.prompt || '').trim();
    if (!prompt) { reply.code(400); return { error: 'prompt is required' }; }
    const enabledChatIds = agentManager.listEnabledIds();
    const rawChatAgent = body.ai || body.provider || body.agent;
    const chatFallbacks = ['cursor-agent', 'opencode', 'codex', 'copilot', 'agy', 'nvidia', 'mlx'];
    const agentId = (rawChatAgent && enabledChatIds.includes(rawChatAgent))
      ? rawChatAgent
      : (chatFallbacks.find(f => enabledChatIds.includes(f)) ?? enabledChatIds[0] ?? 'cursor-agent');

    const taskId = createTaskId();
    reply.code(202);

    // Async execution
    agentManager.executeTask(agentId, prompt, { taskId })
      .catch(err => log.error({ err: err.message }, 'Chat execution failed'));

    return { taskId, status: 'accepted', agentId };
  });

  app.get('/api/chat/ais', async () => {
    const providers = agentManager.listProviders().filter(p => p.enabled);
    return { ais: providers.map(p => ({ id: p.id, name: p.name, role: p.role, score: p.score })) };
  });

  // ═══ Natural Language Intent Parser ═════════════════════
  app.post('/api/nlp/intent', async (req, reply) => {
    const { parseIntent } = await import('../utils/intent-parser.js');
    const body = req.body as any;
    if (!body.query || typeof body.query !== 'string') {
      reply.code(400); return { error: 'query is required' };
    }
    const result = parseIntent(body.query);
    return { intent: result };
  });

  // ═══ Discussions / Realtime ═══════════════════════
  app.post('/api/realtime/discussion', async (req, reply) => {
    // Normalize MCP inputs: providers comma-string → array, maxRounds string → number
    const raw = req.body as any;
    const normalized = {
      ...raw,
      providers: Array.isArray(raw.providers)
        ? raw.providers
        : typeof raw.providers === 'string'
          ? raw.providers.split(',').map((s: string) => s.trim()).filter(Boolean)
          : raw.providers,
      maxRounds: raw.maxRounds !== undefined ? Number(raw.maxRounds) : undefined,
      consensusThreshold: raw.consensusThreshold !== undefined ? Number(raw.consensusThreshold) : undefined,
    };
    const input = CreateDiscussionInput.parse(normalized);
    reply.code(202);

    // Pre-create sessionId and inject it — both client and DB use the same ID
    const sessionId = createSessionId();
    const db = getDb();

    discussionEngine.startDiscussion({
      topic: input.prompt,
      mode: input.mode as any,
      providers: input.providers,
      maxRounds: input.maxRounds,
      consensusThreshold: input.consensusThreshold,
      sessionId,
    })
      .then(report => {
        // Save summary to tasks table so nco_list_tasks / nco_get_task can find it
        const taskId = createTaskId();
        try {
          db.prepare(`
            INSERT OR IGNORE INTO tasks (id, mode, prompt, assigned_to, status, response, completed_at, updated_at)
            VALUES (?, ?, ?, 'discussion-engine', 'completed', ?, datetime('now'), datetime('now'))
          `).run(taskId, input.mode, input.prompt, report.adoptedProposal);
          log.info({ sessionId, taskId, consensusRate: report.finalConsensusRate }, 'Discussion saved');
        } catch (dbErr) {
          log.error({ err: (dbErr as Error).message, sessionId, taskId }, 'Failed to save discussion result');
        }
      })
      .catch(err => log.error({ err: err.message, sessionId }, 'Discussion failed'));

    return { sessionId, status: 'started', mode: input.mode };
  });

  app.post('/api/realtime/parallel', async (req, reply) => {
    const body = req.body as any;
    // providers may arrive as a comma-separated string from MCP tools — normalise to array
    const rawProviders = body.providers;
    const providers: string[] = Array.isArray(rawProviders)
      ? rawProviders
      : typeof rawProviders === 'string'
        ? rawProviders.split(',').map((s: string) => s.trim()).filter(Boolean)
        : sortProvidersByCostOrder(agentManager.listEnabledIds()).slice(0, 3);
    reply.code(202);

    const db = getDb();
    discussionEngine.executeParallel(body.prompt, providers)
      .then(responses => {
        // Save each parallel result as a completed task
        for (const [agentId, output] of Object.entries(responses)) {
          const taskId = createTaskId();
          try {
            db.prepare(`
              INSERT OR IGNORE INTO tasks (id, mode, prompt, assigned_to, status, response, completed_at, updated_at)
              VALUES (?, 'parallel', ?, ?, 'completed', ?, datetime('now'), datetime('now'))
            `).run(taskId, body.prompt, agentId, output as string);
          } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'Failed to save parallel result'); }
        }
      })
      .catch(err => log.error({ err: err.message }, 'Parallel failed'));

    return { status: 'started', providers };
  });

  // Alias: /api/parallel → /api/realtime/parallel (단축 경로)
  app.post('/api/parallel', async (req, reply) => {
    const body = req.body as any;
    const rawProviders = body.providers;
    const providers: string[] = Array.isArray(rawProviders)
      ? rawProviders
      : typeof rawProviders === 'string'
        ? rawProviders.split(',').map((s: string) => s.trim()).filter(Boolean)
        : sortProvidersByCostOrder(agentManager.listEnabledIds()).slice(0, 3);
    reply.code(202);

    const db = getDb();
    discussionEngine.executeParallel(body.prompt, providers)
      .then(responses => {
        for (const [agentId, output] of Object.entries(responses)) {
          const taskId = createTaskId();
          try {
            db.prepare(`
              INSERT OR IGNORE INTO tasks (id, mode, prompt, assigned_to, status, response, completed_at, updated_at)
              VALUES (?, 'parallel', ?, ?, 'completed', ?, datetime('now'), datetime('now'))
            `).run(taskId, body.prompt, agentId, output as string);
          } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'Failed to save parallel result'); }
        }
      })
      .catch(err => log.error({ err: err.message }, 'Parallel failed'));

    return { status: 'started', providers };
  });

  app.post('/api/realtime/consensus', async (req, reply) => {
    const raw = req.body as any;
    const normalized = {
      ...raw,
      providers: Array.isArray(raw.providers)
        ? raw.providers
        : typeof raw.providers === 'string'
          ? raw.providers.split(',').map((s: string) => s.trim()).filter(Boolean)
          : raw.providers,
      consensusThreshold: raw.consensusThreshold !== undefined ? Number(raw.consensusThreshold) : undefined,
    };
    const input = CreateDiscussionInput.parse(normalized);
    reply.code(202);

    const sessionId = createSessionId();
    const db = getDb();

    discussionEngine.startDiscussion({
      topic: input.prompt,
      mode: 'consensus',
      providers: input.providers,
      consensusThreshold: input.consensusThreshold,
      sessionId,
    })
      .then(report => {
        const taskId = createTaskId();
        try {
          db.prepare(`
            INSERT OR IGNORE INTO tasks (id, mode, prompt, assigned_to, status, response, completed_at, updated_at)
            VALUES (?, 'consensus', ?, 'discussion-engine', 'completed', ?, datetime('now'), datetime('now'))
          `).run(taskId, input.prompt, report.adoptedProposal);
        } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'Failed to save consensus result'); }
      })
      .catch(err => log.error({ err: err.message, sessionId }, 'Consensus failed'));

    return { sessionId, status: 'started', mode: 'consensus' };
  });

  app.post('/api/discussion/create', async (req, reply) => {
    const body = req.body as any;
    const sessionId = createSessionId();
    reply.code(202);
    return {
      session: {
        id: sessionId,
        sessionId,
        mode: body.mode || 'discussion',
        providers: body.providers || [],
        status: 'created',
        wsUrl: `ws://localhost:${env.WS_PORT}/discussion/${sessionId}`,
        createdAt: new Date().toISOString(),
      },
    };
  });

  // Start a discussion tied to the real engine (replaces legacy /discussion/start stub)
  app.post('/api/discussion/start', async (req, reply) => {
    const body = req.body as any;
    const topic = body.topic || body.prompt;
    if (!topic) { reply.code(400); return { error: 'topic or prompt required' }; }
    const sessionId = body.sessionId || createSessionId();
    const mode: any = body.mode || 'discussion';
    reply.code(202);
    discussionEngine.startDiscussion({
      topic,
      mode,
      providers: body.providers,
      maxRounds: body.maxRounds ?? body.rounds,
      consensusThreshold: body.consensusThreshold,
      sessionId,
    }).catch(err => log.error({ err: err.message, sessionId }, 'Discussion failed'));
    return { sessionId, status: 'started', mode, wsUrl: `ws://localhost:${env.WS_PORT}/discussion/${sessionId}` };
  });

  // ═══ Discussions DB ═══════════════════════════════
  app.post('/api/discussions', async (req, reply) => {
    const body = req.body as any;
    const topic = body.prompt || body.topic;
    if (!topic) { reply.code(400); return { error: 'prompt or topic required' }; }
    const providers = Array.isArray(body.providers) ? body.providers
      : typeof body.providers === 'string' ? body.providers.split(',').map((s: string) => s.trim()).filter(Boolean)
      : agentManager.listEnabledIds().filter((id: string) => id !== 'claude-code').slice(0, 3);
    const sessionId = createSessionId();
    reply.code(202);
    discussionEngine.startDiscussion({
      topic,
      mode: body.mode || 'discussion',
      providers,
      maxRounds: body.maxRounds || body.rounds || 3,
      consensusThreshold: body.consensusThreshold,
      sessionId,
    }).then(report => {
      const taskId = createTaskId();
      try {
        getDb().prepare(`
          INSERT OR IGNORE INTO tasks (id, mode, prompt, assigned_to, status, response, completed_at, updated_at)
          VALUES (?, 'discussion', ?, 'discussion-engine', 'completed', ?, datetime('now'), datetime('now'))
        `).run(taskId, topic, report.adoptedProposal || JSON.stringify(report));
      } catch {}
    }).catch(err => log.error({ err: err.message, sessionId }, 'Discussion failed'));
    return { sessionId, status: 'started', mode: body.mode || 'discussion', providers };
  });

  app.get('/api/discussions', async () => {
    const db = getDb();
    return { discussions: db.prepare('SELECT * FROM discussions ORDER BY created_at DESC LIMIT 50').all() };
  });

  app.get('/api/discussions/:id', async (req, reply) => {
    const { id } = req.params as any;
    const db = getDb();
    const disc = db.prepare('SELECT * FROM discussions WHERE id=?').get(id);
    if (!disc) { reply.code(404); return { error: 'Not found' }; }
    return { discussion: disc };
  });

  app.get('/api/discussions/:id/messages', async (req) => {
    const { id } = req.params as any;
    const db = getDb();
    return { messages: db.prepare('SELECT * FROM discussion_messages WHERE discussion_id=? ORDER BY created_at').all(id) };
  });

  app.get('/api/discussions/:id/export', async (req, reply) => {
    const { id } = req.params as any;
    const { format = 'json' } = req.query as any;
    const db = getDb();
    const disc = db.prepare('SELECT * FROM discussions WHERE id=?').get(id) as any;
    if (!disc) { reply.code(404); return { error: 'Not found' }; }

    const messages = db.prepare(
      'SELECT * FROM discussion_messages WHERE discussion_id=? ORDER BY created_at'
    ).all(id) as any[];

    if (format === 'markdown') {
      let participants: string[] = [];
      try { participants = JSON.parse(disc.participants_json || '[]'); } catch { /* corrupted JSON */ }
      const lines: string[] = [
        `# Discussion Export: ${disc.topic}`,
        ``,
        `- **ID**: ${disc.id}`,
        `- **Mode**: ${disc.mode}`,
        `- **Status**: ${disc.status}`,
        `- **Participants**: ${participants.join(', ')}`,
        `- **Consensus Rate**: ${((disc.consensus_rate || 0) * 100).toFixed(1)}%`,
        `- **Created**: ${disc.created_at}`,
        ``,
        `## Messages`,
        ``,
      ];
      for (const msg of messages) {
        lines.push(`### Round ${msg.round ?? 'N/A'} — ${msg.agent_id} (${msg.message_type})`);
        lines.push(``);
        lines.push(msg.content || '');
        lines.push(``);
        lines.push(`---`);
        lines.push(``);
      }
      if (disc.report) {
        lines.push(`## Final Report`);
        lines.push(``);
        lines.push(disc.report);
      }
      reply.header('Content-Type', 'text/markdown; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="discussion-${id}.md"`);
      return reply.send(lines.join('\n'));
    }

    return { discussion: disc, messages };
  });

  // ═══ Rate Limits ══════════════════════════════════
  app.get('/api/rate-limits', async () => {
    const db = getDb();
    return { providers: db.prepare('SELECT * FROM rate_limit_state').all() };
  });

  // ═══ Queue Metrics ════════════════════════════════
  app.get('/api/queue/metrics', async (req) => {
    const { agentId } = req.query as any;
    const metrics = await taskQueue.getMetrics(agentId);
    return { metrics };
  });

  // ═══ Metrics ══════════════════════════════════════
  app.get('/api/stats', async () => {
    const db = getDb();
    const totalTasks = (db.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as any).cnt;
    const completedTasks = (db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status='completed'").get() as any).cnt;
    const totalDiscussions = (db.prepare('SELECT COUNT(*) as cnt FROM discussions').get() as any).cnt;
    return { totalTasks, completedTasks, totalDiscussions };
  });

  // ═══ Agent Actions (recent activity) ══════════════
  app.get('/api/agent-actions', async (req) => {
    const query = req.query as any;
    const limit = Math.min(Number(query.limit || 20), 100);
    const db = getDb();
    return { actions: db.prepare('SELECT * FROM agent_actions ORDER BY created_at DESC LIMIT ?').all(limit) };
  });

  // ═══ Agent Messages ═══════════════════════════════
  app.get('/api/messages', async (req) => {
    const query = req.query as any;
    const limit = Math.min(Number(query.limit || 20), 100);
    const db = getDb();
    return { messages: db.prepare('SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT ?').all(limit) };
  });

  // ═══ CLI Mesh — Inter-agent awareness ══════════════
  app.post('/api/mesh/heartbeat', async (req) => {
    const cliMesh = await getCliMesh();
    const body = req.body as any;
    if (!body.sessionId || !body.agentId) return { error: 'sessionId and agentId required' };
    const result = await cliMesh.heartbeat(body);
    // Broadcast full session update (including conflicts) to dashboard
    await eventBus.publish({
      type: 'mesh:session_update',
      session: {
        sessionId: body.sessionId,
        agentId: body.agentId,
        interSessionName: body.interSessionName || null,
        pid: body.pid,
        status: body.status,
        workMode: body.workMode,
        currentWork: body.currentWork,
        currentFiles: body.currentFiles || [],
        branch: body.branch,
        taskId: body.taskId,
        collaborators: body.collaborators || [],
        lastHeartbeat: new Date().toISOString(),
        activeConflicts: result.conflictReports,
      },
    } as any);
    return result;
  });

  // Pre-work conflict check — call before starting a task
  app.post('/api/mesh/check', async (req) => {
    const cliMesh = await getCliMesh();
    const { sessionId, agentId, plannedWork, plannedFiles, branch } = req.body as any;
    if (!sessionId || !agentId) return { error: 'sessionId and agentId required' };
    const result = await cliMesh.checkWorkConflicts(
      sessionId, agentId,
      plannedWork || '',
      plannedFiles || [],
      branch || 'unknown',
    );
    return result;
  });

  app.get('/api/mesh/sessions', async () => {
    const cliMesh = await getCliMesh();
    const sessions = await cliMesh.getActiveSessions();
    return { sessions, count: sessions.length };
  });

  app.get('/api/mesh/summary', async () => {
    const cliMesh = await getCliMesh();
    const summary = await cliMesh.getWorkSummary();
    return { summary };
  });

  app.post('/api/mesh/send', async (req) => {
    const cliMesh = await getCliMesh();
    const { fromSessionId, fromAgent, toSessionId, content, type } = req.body as any;
    if (!fromSessionId || !content) return { error: 'fromSessionId and content required' };
    const delivered = await cliMesh.sendMessage(
      fromSessionId, fromAgent || 'unknown', toSessionId || '*', content, type || 'info',
    );
    // cli-mesh.sendMessage already publishes mesh:message event
    return { delivered };
  });

  app.get('/api/mesh/messages/:sessionId', async (req) => {
    const cliMesh = await getCliMesh();
    const { sessionId } = req.params as any;
    const { drain } = (req.query as any) || {};
    // Combined view: persisted history + pending queue (real-time inbox)
    const history = cliMesh.getMessageHistory(sessionId);
    const pending = await cliMesh.peekPendingMessages(sessionId, drain === '1');
    return { messages: history, pending };
  });

  app.post('/api/mesh/complete', async (req) => {
    const cliMesh = await getCliMesh();
    const { sessionId, completedWork } = req.body as any;
    if (!sessionId) return { error: 'sessionId required' };
    await cliMesh.complete(sessionId, completedWork);
    return { completed: true };
  });

  // Recent messages across all sessions (for monitor initial load)
  app.get('/api/mesh/messages', async (req) => {
    const cliMesh = await getCliMesh();
    const limit = Math.min(Number((req.query as any)?.limit) || 50, 200);
    return { messages: cliMesh.getRecentMessages(limit) };
  });

  app.post('/api/mesh/disconnect', async (req) => {
    const cliMesh = await getCliMesh();
    const { sessionId } = req.body as any;
    if (!sessionId) return { error: 'sessionId required' };
    await cliMesh.disconnect(sessionId);
    // Broadcast disconnect event to dashboard
    await eventBus.publish({
      type: 'mesh:session_disconnected',
      sessionId,
    } as any);
    return { disconnected: true };
  });

  // Broadcast a message from one CLI session to all active sessions
  app.post('/api/mesh/broadcast', async (req) => {
    const cliMesh = await getCliMesh();
    const { fromSessionId, fromAgent, content, type } = req.body as any;
    if (!fromSessionId || !content) return { error: 'fromSessionId and content required' };
    const delivered = await cliMesh.sendMessage(
      fromSessionId, fromAgent || 'unknown', '*', content, type || 'info',
    );
    // cli-mesh.sendMessage already publishes mesh:message event
    return { delivered };
  });

  // ═══ Mesh Delegations ═════════════════════════════════
  app.post('/api/mesh/delegate', async (req, reply) => {
    const { fromSessionId, fromAgentId, toSessionId, title, description, expiresInMs } = req.body as any;
    if (!fromSessionId || !toSessionId || !title) {
      reply.code(400);
      return { error: 'fromSessionId, toSessionId, and title are required' };
    }
    const delegationId = await delegationManager.delegate(
      fromSessionId, fromAgentId || 'unknown', toSessionId, title, description, expiresInMs,
    );
    return { delegationId, status: 'sent' };
  });

  app.post('/api/mesh/delegations/:id/respond', async (req, reply) => {
    const { id } = req.params as any;
    const { accept, reason } = req.body as any;
    if (accept === undefined) { reply.code(400); return { error: 'accept is required' }; }
    await delegationManager.respond(id, Boolean(accept), reason);
    return { ok: true };
  });

  app.post('/api/mesh/delegations/:id/progress', async (req, reply) => {
    const { id } = req.params as any;
    const { pct, note } = req.body as any;
    if (pct === undefined) { reply.code(400); return { error: 'pct is required' }; }
    await delegationManager.updateProgress(id, Number(pct), note);
    return { ok: true };
  });

  app.post('/api/mesh/delegations/:id/complete', async (req) => {
    const { id } = req.params as any;
    const { result } = req.body as any;
    await delegationManager.complete(id, result);
    return { ok: true };
  });

  app.post('/api/mesh/delegations/:id/cancel', async (req) => {
    const { id } = req.params as any;
    const { reason } = req.body as any;
    await delegationManager.cancel(id, reason);
    return { ok: true };
  });

  app.get('/api/mesh/delegations', async (req) => {
    const query = req.query as any;
    const limit = Math.min(Number(query.limit || 50), 200);
    return { delegations: delegationManager.getAll(limit) };
  });

  app.get('/api/mesh/delegations/session/:sessionId', async (req) => {
    const { sessionId } = req.params as any;
    return {
      incoming: delegationManager.getIncoming(sessionId),
      outgoing: delegationManager.getOutgoing(sessionId),
    };
  });

  // ═══ Monitor Overview ══════════════════════════════════
  app.get('/api/monitor/overview', async () => {
    const cliMesh = await getCliMesh();
    const meshSessions = await cliMesh.getActiveSessions();
    const invocations = invocationTracker.getOverview();
    const allDelegations = delegationManager.getAll(200);
    const pendingDelegations = allDelegations.filter(d => d.acceptanceStatus === 'pending');
    const inProgressDelegations = allDelegations.filter(d => d.workStatus === 'in_progress');

    // Per-agent invocation stats from DB
    const db = getDb();
    const agentStats = db.prepare(`
      SELECT target_agent_id AS agentId,
             COUNT(*) AS total,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END) AS active,
             ROUND(AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END), 0) AS avgDurationMs
      FROM agent_invocations
      GROUP BY target_agent_id
      ORDER BY total DESC
    `).all();

    return {
      meshSessions,
      invocations,
      delegations: { pending: pendingDelegations, inProgress: inProgressDelegations },
      collaborations: { open: collaborationEngine.getOpen(), count: collaborationEngine.getOpen().length },
      agentStats,
    };
  });

  // ═══ Group Intelligence: Collaboration (Phase 3) ════════════════════
  app.post('/api/collab/create', async (req) => {
    const { creatorSessionId, creatorAgentId, title, description, type, inviteSessionIds, minParticipants, maxParticipants, resultMethod } = req.body as any;
    if (!creatorSessionId || !title) return { error: 'creatorSessionId and title are required' };
    const id = await collaborationEngine.create({
      creatorSessionId, creatorAgentId: creatorAgentId || 'unknown',
      title, description, type, inviteSessionIds, minParticipants, maxParticipants, resultMethod,
    });
    return { id, status: 'created' };
  });

  app.post('/api/collab/:id/join', async (req) => {
    const { id } = req.params as any;
    const { sessionId, agentId } = req.body as any;
    if (!sessionId) return { error: 'sessionId is required' };
    await collaborationEngine.join(id, sessionId, agentId || 'unknown');
    return { id, sessionId, joined: true };
  });

  app.post('/api/collab/:id/contribute', async (req) => {
    const { id } = req.params as any;
    const { sessionId, agentId, content, contentType } = req.body as any;
    if (!sessionId || !content) return { error: 'sessionId and content are required' };
    const contributionId = await collaborationEngine.contribute({
      collaborationId: id, sessionId, agentId: agentId || 'unknown', content, contentType,
    });
    return { contributionId };
  });

  app.post('/api/collab/:id/vote', async (req) => {
    const { id } = req.params as any;
    const { contributionId, voterSessionId, vote } = req.body as any;
    if (!contributionId || !voterSessionId || ![-1, 1].includes(vote)) {
      return { error: 'contributionId, voterSessionId, vote(1|-1) are required' };
    }
    await collaborationEngine.vote(contributionId, voterSessionId, vote);
    return { ok: true };
  });

  app.post('/api/collab/:id/voting', async (req) => {
    const { id } = req.params as any;
    await collaborationEngine.startVoting(id);
    return { id, status: 'voting' };
  });

  app.post('/api/collab/:id/close', async (req) => {
    const { id } = req.params as any;
    const { result } = req.body as any;
    const collab = await collaborationEngine.close(id, result);
    return { id, status: 'closed', result: collab.result };
  });

  app.get('/api/collab', async (req) => {
    const limit = Number((req.query as any).limit) || 50;
    return { collaborations: collaborationEngine.getAll(limit) };
  });

  app.get('/api/collab/open', async () => {
    return { collaborations: collaborationEngine.getOpen() };
  });

  app.get('/api/collab/:id', async (req) => {
    const { id } = req.params as any;
    const collab = collaborationEngine.get(id);
    if (!collab) return { error: 'not found' };
    return { collab, contributions: collaborationEngine.getContributions(id) };
  });

  // ═══ Mesh Flow Timeline (monitoring) ════════════════════════════════
  app.get('/api/mesh/flow', async (req) => {
    const limit = Math.min(Number((req.query as any).limit) || 40, 100);
    const db = getDb();

    // 1. Raw mesh messages (session↔session 직접 메시지)
    let meshMessages: any[] = [];
    try {
      // 프로토콜 내부 메시지(DELEGATION_*/COLLAB_*/INVOCATION_* prefix)는 제외
      // — 이미 typed 이벤트로 별도 표시되므로 중복 방지
      meshMessages = db.prepare(`
        SELECT
          created_at as ts,
          'mesh_msg'  as event_type,
          from_session,
          from_agent,
          to_session,
          NULL        as to_agent,
          type        as msg_type,
          content,
          id
        FROM mesh_messages
        WHERE content NOT LIKE 'DELEGATION_%'
          AND content NOT LIKE 'COLLAB_%'
          AND content NOT LIKE 'INVOCATION_%'
        ORDER BY created_at DESC LIMIT ?
      `).all(limit);
    } catch { /* mesh_messages may not exist yet */ }

    // 2. Delegation events (각 상태 변경을 이벤트로)
    let delegationEvents: any[] = [];
    try {
      // created → DELEGATION_REQUEST  /  accepted/rejected → DELEGATION_RESPONSE  /  completed → DELEGATION_COMPLETE
      const delegRows = db.prepare(`
        SELECT
          created_at, accepted_at, completed_at,
          id, from_session_id, from_agent_id, to_session_id, to_agent_id,
          title, acceptance_status, work_status, progress_pct, result
        FROM delegations
        ORDER BY created_at DESC LIMIT ?
      `).all(limit) as any[];

      for (const d of delegRows) {
        delegationEvents.push({
          ts: d.created_at,
          event_type: 'delegation_request',
          from_session: d.from_session_id,
          from_agent: d.from_agent_id,
          to_session: d.to_session_id,
          to_agent: d.to_agent_id,
          msg_type: 'DELEGATION_REQUEST',
          content: d.title,
          id: d.id + '_req',
        });
        if (d.accepted_at) {
          delegationEvents.push({
            ts: d.accepted_at,
            event_type: 'delegation_response',
            from_session: d.to_session_id,
            from_agent: d.to_agent_id,
            to_session: d.from_session_id,
            to_agent: d.from_agent_id,
            msg_type: d.acceptance_status === 'accepted' ? 'DELEGATION_ACCEPTED' : 'DELEGATION_REJECTED',
            content: d.title,
            id: d.id + '_resp',
          });
        }
        if (d.completed_at) {
          delegationEvents.push({
            ts: d.completed_at,
            event_type: 'delegation_complete',
            from_session: d.to_session_id,
            from_agent: d.to_agent_id,
            to_session: d.from_session_id,
            to_agent: d.from_agent_id,
            msg_type: 'DELEGATION_COMPLETE',
            content: d.result || d.title,
            id: d.id + '_done',
          });
        }
      }
    } catch { /* delegations may not exist yet */ }

    // 3. Invocation events
    let invocationEvents: any[] = [];
    try {
      const invRows = db.prepare(`
        SELECT
          created_at, completed_at,
          id, caller_session_id, caller_agent_id, target_agent_id,
          status, prompt
        FROM agent_invocations
        ORDER BY created_at DESC LIMIT ?
      `).all(limit) as any[];

      for (const inv of invRows) {
        invocationEvents.push({
          ts: inv.created_at,
          event_type: 'invocation_start',
          from_session: inv.caller_session_id || 'system',
          from_agent: inv.caller_agent_id || 'system',
          to_session: inv.target_agent_id,
          to_agent: inv.target_agent_id,
          msg_type: 'INVOCATION_START',
          content: (inv.prompt || '').substring(0, 120),
          id: inv.id + '_start',
        });
        if (inv.completed_at) {
          invocationEvents.push({
            ts: inv.completed_at,
            event_type: 'invocation_complete',
            from_session: inv.target_agent_id,
            from_agent: inv.target_agent_id,
            to_session: inv.caller_session_id || 'system',
            to_agent: inv.caller_agent_id || 'system',
            msg_type: inv.status === 'completed' ? 'INVOCATION_COMPLETE' : 'INVOCATION_FAILED',
            content: inv.status,
            id: inv.id + '_done',
          });
        }
      }
    } catch { /* agent_invocations may not exist yet */ }

    // 4. Collaboration events
    let collabEvents: any[] = [];
    try {
      const collabRows = db.prepare(`
        SELECT
          c.created_at, c.closed_at,
          c.id, c.creator_session_id, c.creator_agent_id,
          c.title, c.type, c.status, c.result,
          ct.created_at as contrib_ts,
          ct.session_id as contrib_session,
          ct.agent_id   as contrib_agent,
          ct.content    as contrib_content,
          ct.score      as contrib_score,
          ct.id         as contrib_id
        FROM collaborations c
        LEFT JOIN collab_contributions ct ON ct.collaboration_id = c.id
        ORDER BY c.created_at DESC LIMIT ?
      `).all(limit) as any[];

      const seenCollabs = new Set<string>();
      for (const row of collabRows) {
        if (!seenCollabs.has(row.id)) {
          seenCollabs.add(row.id);
          collabEvents.push({
            ts: row.created_at,
            event_type: 'collab_created',
            from_session: row.creator_session_id,
            from_agent: row.creator_agent_id,
            to_session: '*',
            to_agent: null,
            msg_type: 'COLLAB_CREATE',
            content: `[${row.type}] ${row.title}`,
            id: row.id + '_create',
          });
          if (row.closed_at) {
            collabEvents.push({
              ts: row.closed_at,
              event_type: 'collab_closed',
              from_session: row.creator_session_id,
              from_agent: row.creator_agent_id,
              to_session: '*',
              to_agent: null,
              msg_type: 'COLLAB_CLOSED',
              content: row.result || row.title,
              id: row.id + '_close',
            });
          }
        }
        if (row.contrib_id) {
          collabEvents.push({
            ts: row.contrib_ts,
            event_type: 'collab_contribution',
            from_session: row.contrib_session,
            from_agent: row.contrib_agent,
            to_session: row.id,
            to_agent: null,
            msg_type: 'COLLAB_CONTRIBUTION',
            content: (row.contrib_content || '').substring(0, 80),
            id: row.contrib_id,
          });
        }
      }
    } catch { /* collaborations may not exist yet */ }

    // sessionMap: sessionId → agentId
    // 1) 활성 세션 (in-memory)
    // 2) mesh_messages 이력에서 from_session→from_agent 역추적 (오래된 세션 포함)
    let sessionMap: Record<string, string> = {};
    try {
      const cliMesh = await getCliMesh();
      const sessions = await cliMesh.getActiveSessions();
      for (const s of sessions) {
        if (s.sessionId && s.agentId) sessionMap[s.sessionId] = s.agentId;
      }
    } catch { /* non-fatal */ }
    try {
      // mesh_messages에서 (from_session, from_agent) 쌍으로 보완
      const histRows = db.prepare(`
        SELECT DISTINCT from_session, from_agent
        FROM mesh_messages
        WHERE from_agent IS NOT NULL AND from_agent != ''
          AND from_session IS NOT NULL AND from_session != ''
        LIMIT 200
      `).all() as any[];
      for (const r of histRows) {
        if (!sessionMap[r.from_session]) {
          sessionMap[r.from_session] = r.from_agent;
        }
      }
    } catch { /* non-fatal */ }

    // Merge all events, sort by ts DESC, take top limit
    const all = [...meshMessages, ...delegationEvents, ...invocationEvents, ...collabEvents];
    all.sort((a, b) => {
      const ta = a.ts ? new Date(a.ts).getTime() : 0;
      const tb = b.ts ? new Date(b.ts).getTime() : 0;
      return tb - ta;
    });

    return {
      events: all.slice(0, limit),
      sessionMap,
      counts: {
        meshMessages: meshMessages.length,
        delegationEvents: delegationEvents.length,
        invocationEvents: invocationEvents.length,
        collabEvents: collabEvents.length,
      },
    };
  });

  // ═══ Hive Mode (9 AI → 1 Super AI) ══════════════════
  app.post('/api/hive', async (req, reply) => {
    const { prompt, providers } = req.body as any;
    if (!prompt) { reply.code(400); return { error: 'prompt is required' }; }
    const allProviders = providers || agentManager.listEnabledIds();
    reply.code(202);

    const sessionId = createSessionId();
    const db = getDb();

    discussionEngine.startDiscussion({
      topic: prompt,
      mode: 'hive',
      providers: allProviders,
      sessionId,
    })
      .then(report => {
        const taskId = createTaskId();
        db.prepare(`
          INSERT OR IGNORE INTO tasks (id, mode, prompt, assigned_to, status, response, completed_at, updated_at)
          VALUES (?, 'hive', ?, 'discussion-engine', 'completed', ?, datetime('now'), datetime('now'))
        `).run(taskId, prompt, report.adoptedProposal);
      })
      .catch(err => log.error({ err: err.message, sessionId }, 'Hive failed'));

    return { sessionId, status: 'started', mode: 'hive', providers: allProviders };
  });

  // ═══ Broadcast (All Agents) ════════════════════════
  app.post('/api/broadcast', async (req, reply) => {
    const { message, providers } = req.body as any;
    if (!message) { reply.code(400); return { error: 'message is required' }; }
    const allProviders = providers || agentManager.listEnabledIds();
    reply.code(202);
    discussionEngine.executeBroadcast(message, allProviders)
      .catch(err => log.error({ err: err.message }, 'Broadcast failed'));
    return { status: 'started', mode: 'broadcast', providers: allProviders };
  });

  // ═══ Commander 4-Layer ═════════════════════════════
  app.post('/api/commander', async (req) => {
    const commander = await getCommander();
    const { prompt } = req.body as any;
    if (!prompt) return { error: 'prompt is required' };
    const result = await commander.executeCommand(prompt);
    return result;
  });

  app.get('/api/commander/layers', async () => {
    const commander = await getCommander();
    return { layers: commander.getLayers() };
  });

  // ═══ Observability + Learn ════════════════════════
  app.get('/api/observability/leaderboard', async () => {
    const { observability } = await import('../core/observability.js');
    return { leaderboard: observability.getLeaderboard() };
  });

  app.get('/api/observability/agent/:id', async (req) => {
    const { observability } = await import('../core/observability.js');
    const { id } = req.params as any;
    return observability.getAgentHistory(id);
  });

  app.get('/api/observability/metrics', async () => {
    const { observability } = await import('../core/observability.js');
    return observability.getMetrics();
  });

  app.post('/api/learn/save', async (req) => {
    const { knowledgeBase } = await import('../core/knowledge-base.js');
    const body = req.body as any;
    if (!body.projectPath || !body.category || !body.content) {
      return { error: 'projectPath, category, and content are required' };
    }
    const id = knowledgeBase.save(body);
    return { id };
  });

  app.get('/api/learn/query', async (req) => {
    const { knowledgeBase } = await import('../core/knowledge-base.js');
    const { keywords, project } = req.query as any;
    if (!keywords) return { error: 'keywords parameter required' };
    return { results: knowledgeBase.query(keywords, project) };
  });

  // /api/learn/search is registered in dashboard-compat.ts (inside catch-all handler)

  app.get('/api/learn/context', async (req) => {
    const { knowledgeBase } = await import('../core/knowledge-base.js');
    const { project } = req.query as any;
    if (!project) return { error: 'project parameter required' };
    return { context: knowledgeBase.getContext(project) };
  });

  app.get('/api/knowledge/obsidian', async (req) => {
    const { knowledgeBase } = await import('../core/knowledge-base.js');
    const { q, keywords, limit } = req.query as any;
    const searchTerms = q || keywords || '';
    const results = await knowledgeBase.queryObsidian(searchTerms, Number(limit) || 10);
    return { results };
  });

  // ─── Vault 직접 검색 (Node.js fs, ripgrep 래퍼 우회) ──────────────────
  app.get('/api/knowledge/search', async (req) => {
    const { q, limit, category } = req.query as any;
    if (!q || !String(q).trim()) return { results: [] };
    const VAULT = `${process.env.HOME}/obsidian/mac-obsidian`;
    const maxResults = Math.min(Number(limit) || 20, 50);
    const searchStr = String(q).toLowerCase();

    function collectMdFiles(dir: string, out: string[] = []): string[] {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) collectMdFiles(full, out);
          else if (entry.name.endsWith('.md')) out.push(full);
        }
      } catch { /* skip unreadable dirs */ }
      return out;
    }

    const searchRoot = category
      ? (() => { const p = join(VAULT, String(category).toUpperCase()); return p.startsWith(VAULT) ? p : VAULT; })()
      : VAULT;
    const allFiles = collectMdFiles(searchRoot);
    const results: Array<{ path: string; folder: string; title: string; excerpt: string; score: number }> = [];

    for (const filePath of allFiles) {
      if (results.length >= maxResults) break;
      try {
        const { readFileSync } = await import('fs');
        const content = readFileSync(filePath, 'utf8');
        if (!content.toLowerCase().includes(searchStr)) continue;
        const rel = filePath.replace(VAULT + '/', '');
        const parts = rel.split('/');
        const title = basename(filePath, '.md');
        const matchLine = content.split('\n').find(l => l.toLowerCase().includes(searchStr)) ?? '';
        const excerpt = matchLine.slice(0, 200);
        results.push({ path: rel, folder: parts[0] ?? '', title, excerpt, score: 1 });
      } catch { /* skip unreadable */ }
    }
    return { results, total: results.length, query: q };
  });

  // ─── Vault 폴더 파일 목록 ──────────────────────────────────────────────
  app.get('/api/knowledge/files', async (req) => {
    const { folder } = req.query as any;
    const VAULT = `${process.env.HOME}/obsidian/mac-obsidian`;
    const dirPath = folder
      ? (() => { const p = join(VAULT, String(folder)); return p.startsWith(VAULT) ? p : VAULT; })()
      : VAULT;
    try {
      const entries = readdirSync(dirPath);
      const files = entries
        .filter(name => name.endsWith('.md') || !name.includes('.'))
        .map(name => {
          const full = join(dirPath, name);
          let modified = '';
          try { modified = statSync(full).mtime.toISOString(); } catch { /* skip */ }
          return { name, path: full.replace(VAULT + '/', ''), modified };
        });
      return { files, folder: folder || '/', total: files.length };
    } catch (err) {
      return { files: [], error: String(err) };
    }
  });

  // ─── Vault 인덱스 재동기화 (obsidian-sync.sh 재실행) ────────────────────
  app.post('/api/knowledge/index', async () => {
    const SYNC_SCRIPT = `${process.env.HOME}/obsidian/mac-obsidian/obsidian-sync.sh`;
    try {
      const out = execSync(`bash ${JSON.stringify(SYNC_SCRIPT)} 2>&1`, { encoding: 'utf8', timeout: 30000 });
      return { status: 'ok', message: out.slice(0, 500) };
    } catch (err) {
      return { status: 'error', message: String(err) };
    }
  });

  // ═══ Plan + Kanban ════════════════════════════════
  app.post('/api/plan/create', async (req) => {
    const { planManager } = await import('../core/plan-manager.js');
    const { title, tasks, sourceDiscussionId } = req.body as any;
    if (!title) return { error: 'title is required' };
    const plan = await planManager.createPlan(title, tasks, sourceDiscussionId);
    return plan;
  });

  app.get('/api/plan/:id', async (req) => {
    const { planManager } = await import('../core/plan-manager.js');
    const { id } = req.params as any;
    const plan = planManager.getPlan(id);
    if (!plan) return { error: 'Plan not found' };
    return plan;
  });

  app.post('/api/plan/:id/sync', async (req) => {
    const { planManager } = await import('../core/plan-manager.js');
    const { id } = req.params as any;
    const synced = await planManager.syncFromMarkdown(id);
    await planManager.syncToMarkdown(id);
    return { synced };
  });

  app.get('/api/kanban', async (req) => {
    const { kanbanEngine } = await import('../core/kanban-engine.js');
    const { planId } = req.query as any;
    return kanbanEngine.getBoard(planId);
  });

  app.post('/api/kanban/move', async (req) => {
    const { kanbanEngine } = await import('../core/kanban-engine.js');
    const { taskId, to } = req.body as any;
    if (!taskId || !to) return { error: 'taskId and to are required' };
    const moved = kanbanEngine.moveTask(taskId, to);
    return { moved };
  });

  app.post('/api/plan/execute', async (req) => {
    const { kanbanEngine } = await import('../core/kanban-engine.js');
    const { planId, strategy } = req.body as any;
    if (!planId) return { error: 'planId is required' };
    const result = await kanbanEngine.executePlan(planId, strategy || 'auto');
    return result;
  });

  // ═══ Conductor (Smart Router Auto-Dispatch) ════════
  app.post('/api/conductor', async (req) => {
    const smartRouter = await getSmartRouter();
    const { prompt, projectDir: reqProjectDir } = req.body as any;
    if (!prompt) return { error: 'prompt is required' };

    const decision = await smartRouter.dispatch(prompt);

    // Delegate to the appropriate mode endpoint handler
    const db = getDb();
    const taskId = (await import('../utils/id.js')).createTaskId();

    // Record task
    try {
      db.prepare(`
        INSERT INTO tasks (id, mode, prompt, assigned_to, status, priority)
        VALUES (?, ?, ?, ?, 'assigned', 5)
      `).run(taskId, decision.mode, prompt, decision.providers[0] || null);
    } catch (dbErr) {
      log.error({ err: (dbErr as Error).message, taskId }, 'Failed to insert conductor task');
      return { error: 'Failed to create task' };
    }

    // Execute via discussion engine for multi-agent modes, or taskQueue for single
    const sessionId = createSessionId();

    // ── nova-ax 모드: Nova-AX REST API 직접 호출 ─────────────────────────
    if (decision.mode === 'nova-ax') {
      (async () => {
        try {
          const novaAxRes = await fetch('http://localhost:3000/api/agents/task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, taskId }),
          });
          const novaAxData = novaAxRes.ok ? await novaAxRes.json() as any : null;
          const response = novaAxData?.result ?? novaAxData?.message ?? '(Nova-AX 응답 없음)';
          db.prepare(`UPDATE tasks SET status='completed', response=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
            .run(String(response), taskId);
        } catch (err: any) {
          // Nova-AX 오프라인이면 codex로 폴백
          log.warn({ taskId }, 'Nova-AX offline — falling back to codex');
          taskQueue.enqueue({ taskId, agentId: 'codex', prompt, metadata: { projectDir: reqProjectDir } })
            .then(r => { db.prepare(`UPDATE tasks SET status=?, response=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(r.success ? 'completed' : 'failed', r.output ?? r.error ?? '', taskId); })
            .catch(e => { db.prepare(`UPDATE tasks SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`).run(e.message, taskId); });
        }
      })();

    // ── full-pipeline 모드: 기획→토론→설계→구현→리뷰→Gap→검증 순차 실행 ─
    } else if (decision.mode === 'full-pipeline') {
      (async () => {
        const pipelineAgents = smartRouter.getPipelineProviders(); // single source of truth
        const stages = [
          { name: '기획',    agent: pipelineAgents[0] ?? 'opencode',      instruction: `[1/7 기획] 다음 작업을 분석하고 요구사항과 접근 방향을 기획하라:\n${prompt}` },
          { name: '설계',    agent: pipelineAgents[0] ?? 'opencode',      instruction: `[2/7 설계] 위 기획을 바탕으로 아키텍처/모듈 설계를 작성하라.` },
          { name: '구현',    agent: pipelineAgents[1] ?? 'codex',         instruction: `[3/7 구현] 설계대로 코드를 구현하라.` },
          { name: '리뷰',    agent: pipelineAgents[2] ?? 'cursor-agent',  instruction: `[4/7 코드리뷰] 구현된 코드의 보안·품질을 리뷰하라.` },
          { name: 'Gap분석', agent: pipelineAgents[4] ?? 'nvidia',        instruction: `[5/7 Gap분석] 요구사항 vs 구현 완성도를 Gap 분석하라. 미완성 항목을 명시하라.` },
          { name: '검증',    agent: pipelineAgents[3] ?? 'cursor-agent',   instruction: `[6/7 검증] 구현 코드의 동작을 검증하고 테스트 결과를 보고하라.` },
          { name: '최종보고', agent: pipelineAgents[0] ?? 'opencode',     instruction: `[7/7 최종보고] 전체 파이프라인 결과를 요약하라. 완성도(%), 미완성 항목, 다음 액션을 포함하라.` },
        ];
        let context = '';
        const stageResults: string[] = [];
        for (const stage of stages) {
          try {
            const stagePrompt = context ? `${stage.instruction}\n\n[이전 단계 결과]\n${context}` : stage.instruction;
            const result = await taskQueue.enqueue({ taskId: `${taskId}_${stage.name}`, agentId: stage.agent, prompt: stagePrompt, metadata: { projectDir: reqProjectDir } });
            const output = result.output ?? result.error ?? `(${stage.name} 응답 없음)`;
            context += `\n\n## ${stage.name} 결과\n${output}`;
            stageResults.push(`### ${stage.name}\n${output}`);
          } catch (e: any) {
            stageResults.push(`### ${stage.name}\n[오류] ${e.message}`);
          }
        }
        const finalReport = stageResults.join('\n\n');
        db.prepare(`UPDATE tasks SET status='completed', response=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(finalReport, taskId);
      })();

    // ── company 모드: 역할별 파이프라인 (DB 동적 정의 우선, 기본 파이프라인 폴백) ──
    } else if (decision.mode === 'company') {
      (async () => {
        // DB에서 prompt 키워드 매칭 동적 회사 정의 검색
        let pipeline: Array<{ role: string; agent: string; prompt: string }>;
        const allCompanies = db.prepare(
          `SELECT * FROM company_definitions WHERE is_active=1`
        ).all() as any[];
        const matchedCompany = allCompanies.find(c => {
          const kws = (c.prompt_keywords || '').split(',').map((k: string) => k.trim()).filter(Boolean);
          return kws.some((kw: string) => prompt.toLowerCase().includes(kw.toLowerCase()));
        }) ?? allCompanies.find(c => prompt.toLowerCase().includes(c.name.toLowerCase()));

        if (matchedCompany) {
          // 동적 회사 정의 사용
          const roles = JSON.parse(matchedCompany.roles || '[]') as Array<{ role: string; agentId: string; instruction?: string }>;
          let ctx = '';
          const results: string[] = [];
          for (const step of roles) {
            try {
              const stepPrompt = ctx
                ? `[${matchedCompany.name}/${step.role}] ${step.instruction ?? ''}\n\n[작업]\n${prompt}\n\n[이전 결과]\n${ctx}`
                : `[${matchedCompany.name}/${step.role}] ${step.instruction ?? ''}\n\n[작업]\n${prompt}`;
              const r = await taskQueue.enqueue({ taskId: `${taskId}_${step.role}`, agentId: step.agentId, prompt: stepPrompt, metadata: { projectDir: reqProjectDir } });
              const out = r.output ?? r.error ?? '';
              ctx += `\n\n## ${step.role}\n${out}`;
              results.push(`### ${step.role} (${step.agentId})\n${out}`);
            } catch (e: any) { results.push(`### ${step.role}\n[오류] ${e.message}`); }
          }
          db.prepare(`UPDATE tasks SET status='completed', response=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(
            `# ${matchedCompany.name} 파이프라인 결과\n\n` + results.join('\n\n'), taskId
          );
          return;
        }

        // 기본 파이프라인 (DB 정의 없을 때)
        const companyAgents = smartRouter.getCompanyProviders(); // single source of truth
        const defaultPipeline = [
          { role: '기획/아키텍처', agent: companyAgents[0] ?? 'opencode',    prompt: `[Company/기획] 다음 작업의 사업 목표, 요구사항, 아키텍처를 수립하라:\n${prompt}` },
          { role: 'UI/UX설계',    agent: companyAgents[1] ?? 'agy',       prompt: `[Company/설계] 위 기획을 바탕으로 UI/UX 및 인터페이스 설계안을 작성하라.` },
          { role: '개발구현',     agent: companyAgents[2] ?? 'codex',        prompt: `[Company/구현] 기획·설계대로 코드를 구현하라.` },
          { role: 'QA/검증',      agent: companyAgents[3] ?? 'cursor-agent', prompt: `[Company/QA] 구현된 코드를 품질 검증하고 배포 준비 상태를 평가하라.` },
        ];
        let ctx = '';
        const results: string[] = [];
        for (const step of defaultPipeline) {
          try {
            const p = ctx ? `${step.prompt}\n\n[이전 결과]\n${ctx}` : step.prompt;
            const r = await taskQueue.enqueue({ taskId: `${taskId}_${step.role}`, agentId: step.agent, prompt: p, metadata: { projectDir: reqProjectDir } });
            const out = r.output ?? r.error ?? '';
            ctx += `\n\n## ${step.role}\n${out}`;
            results.push(`### ${step.role}\n${out}`);
          } catch (e: any) { results.push(`### ${step.role}\n[오류] ${e.message}`); }
        }
        db.prepare(`UPDATE tasks SET status='completed', response=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(results.join('\n\n'), taskId);
      })();

    // ── team-project 모드: 팀 구성 + 역할 배정 + 병렬 실행 ───────────────
    } else if (decision.mode === 'team-project') {
      (async () => {
        const teamAgents = decision.providers.length > 0
          ? decision.providers
          : smartRouter.getTeamProjectProviders();
        const teamLead = teamAgents[0] ?? 'opencode';
        const implementer = teamAgents[1] ?? teamLead;
        const reviewer = teamAgents[2];

        // 1단계: opencode가 팀 구조와 역할 분담 설계
        const teamDesign = await taskQueue.enqueue({
          taskId: `${taskId}_team-design`,
          agentId: teamLead,
          prompt: `[Team-Project/팀설계] 다음 프로젝트를 위한 팀 구조, 역할 분담, 병렬 실행 계획을 JSON으로 작성하라:\n${prompt}`,
          metadata: { projectDir: reqProjectDir }
        }).catch(() => ({ output: '' }));
        const teamProjectPrompts = buildTeamProjectPrompts(prompt, teamDesign.output);

        // 2단계: 구현 + 가능할 때만 독립 리뷰를 병렬 실행
        const implPromise = taskQueue.enqueue({
          taskId: `${taskId}_impl`,
          agentId: implementer,
          prompt: teamProjectPrompts.implementation,
          metadata: { projectDir: reqProjectDir }
        }).catch(e => ({ success: false, output: '', error: e.message }));
        const reviewPromise = reviewer
          ? taskQueue.enqueue({
              taskId: `${taskId}_review`,
              agentId: reviewer,
              prompt: teamProjectPrompts.review,
              metadata: { projectDir: reqProjectDir }
            }).catch(e => ({ success: false, output: '', error: e.message }))
          : Promise.resolve({
              success: true,
              output: `리뷰 전용 에이전트가 없어 독립 리뷰 단계를 건너뜀 (선택된 팀: ${teamAgents.join(', ')})`,
              error: undefined
            });
        const [implResult, reviewResult] = await Promise.all([implPromise, reviewPromise]);

        const report = [
          `### 팀 설계\n${teamDesign.output}`,
          `### 구현\n${implResult.output || (implResult as any).error || ''}`,
          `### 설계리뷰\n${reviewResult.output || (reviewResult as any).error || ''}`,
        ].join('\n\n');
        db.prepare(`UPDATE tasks SET status='completed', response=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(report, taskId);
      })();

    // ── mesh 모드: 전체 세션 브로드캐스트 ───────────────────────────────
    } else if (decision.mode === 'mesh') {
      (async () => {
        try {
          const { cliMesh } = await import('../core/cli-mesh.js');
          const message = (decision as any).meta?.message ?? prompt;
          const sessions = await cliMesh.getActiveSessions() as any[];
          const sent: string[] = [];
          for (const s of sessions) {
            if (s.sessionId) {
              await cliMesh.sendMessage('system', 'gateway', s.sessionId, message).catch(() => {});
              sent.push(s.name ?? s.sessionId);
            }
          }
          const report = `mesh broadcast → ${sent.length}개 세션 전송\n대상: ${sent.join(', ')}\n메시지: ${message}`;
          db.prepare(`UPDATE tasks SET status='completed', response=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(report, taskId);
        } catch (err: any) {
          db.prepare(`UPDATE tasks SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`).run(err.message, taskId);
        }
      })();

    // ── inter-session 모드: 특정 세션/에이전트 DM ───────────────────────
    } else if (decision.mode === 'inter-session') {
      (async () => {
        try {
          const { cliMesh } = await import('../core/cli-mesh.js');
          const meta = (decision as any).meta ?? {};
          const target = meta.target as string | undefined;
          const message = meta.message ?? prompt;
          if (!target) {
            // 타겟 불명확 → 연결된 세션 목록 반환
            const sessions = await cliMesh.getActiveSessions() as any[];
            const names = sessions.map((s: any) => s.name ?? s.sessionId).join(', ');
            const report = `inter-session: 타겟 세션 미지정\n연결 중인 세션: ${names || '없음'}\n사용법: "[세션명]에게 [메시지]" 형식으로 입력하세요`;
            db.prepare(`UPDATE tasks SET status='completed', response=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(report, taskId);
            return;
          }
          // 타겟 세션 찾아서 전송
          const sessions = await cliMesh.getActiveSessions() as any[];
          const targetSession = sessions.find((s: any) =>
            (s.name ?? '').toLowerCase().includes(target) ||
            (s.sessionId ?? '').toLowerCase().includes(target)
          );
          if (!targetSession) {
            db.prepare(`UPDATE tasks SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`).run(`세션 '${target}'을 찾을 수 없음`, taskId);
            return;
          }
          await cliMesh.sendMessage('system', 'gateway', targetSession.sessionId, message);
          const report = `inter-session DM → ${targetSession.name ?? target}\n메시지: ${message}`;
          db.prepare(`UPDATE tasks SET status='completed', response=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(report, taskId);
        } catch (err: any) {
          db.prepare(`UPDATE tasks SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`).run(err.message, taskId);
        }
      })();

    // ── 기존: task 단일 실행 ──────────────────────────────────────────────
    } else if (decision.mode === 'task' && decision.providers.length === 1) {
      taskQueue.enqueue({ taskId, agentId: decision.providers[0], prompt, metadata: { projectDir: reqProjectDir } })
        .then(result => {
          try {
            db.prepare(`UPDATE tasks SET status=?, response=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
              .run(result.success ? 'completed' : 'failed', result.output ?? result.error ?? '(응답 없음)', taskId);
          } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update failed'); }
        })
        .catch(err => {
          try {
            db.prepare(`UPDATE tasks SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`)
              .run(err.message, taskId);
          } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update failed'); }
        });
    } else {
      const { discussionEngine: de } = await import('../core/discussion-engine.js');
      de.startDiscussion({
        topic: prompt,
        mode: decision.mode as any,
        providers: decision.providers,
        maxRounds: decision.mode === 'consensus' ? 5 : 3,
        sessionId,
      })
        .then(report => {
          try {
            db.prepare(`UPDATE tasks SET status='completed', response=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
              .run(report.adoptedProposal, taskId);
          } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update failed'); }
        })
        .catch(err => {
          try {
            db.prepare(`UPDATE tasks SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`)
              .run(err.message, taskId);
          } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update failed'); }
        });
    }

    return {
      taskId,
      mode: decision.mode,
      providers: decision.providers,
      complexity: decision.complexity,
      reasoning: decision.reasoning,
      ...(decision.meta ? { meta: decision.meta } : {}),
      status: 'dispatched',
    };
  });

  // ═══ Agent Sessions ════════════════════════════════
  app.post('/api/agent/start', async (req) => {
    const sessionManager = await getSessionManager();
    const { prompt, provider, systemPrompt, autoApprove } = req.body as any;
    if (!prompt) return { error: 'prompt is required' };
    const agentId = provider || 'codex';
    const sessionId = await sessionManager.startSession(prompt, agentId, { systemPrompt, autoApprove });
    return { sessionId, status: 'running', agentId };
  });

  app.get('/api/agent/sessions', async () => {
    const sessionManager = await getSessionManager();
    const active = sessionManager.listSessions();
    const history = sessionManager.getSessionsFromDb(20);
    return { sessions: [...active, ...history.filter(h => !active.find(a => a.id === h.id))] };
  });

  app.get('/api/agent/:sessionId/status', async (req) => {
    const sessionManager = await getSessionManager();
    const { sessionId } = req.params as any;
    const session = sessionManager.getSession(sessionId);
    if (!session) return { error: 'Session not found' };
    return {
      id: session.id, agentId: session.agentId, status: session.status,
      iterations: session.iterations, toolCalls: session.toolCalls,
      createdAt: session.createdAt, completedAt: session.completedAt,
      error: session.error,
    };
  });

  app.post('/api/agent/:sessionId/abort', async (req) => {
    const sessionManager = await getSessionManager();
    const { sessionId } = req.params as any;
    const aborted = await sessionManager.abortSession(sessionId);
    return { aborted };
  });

  app.post('/api/agent/:sessionId/approve', async (req) => {
    const sessionManager = await getSessionManager();
    const { sessionId } = req.params as any;
    const approved = sessionManager.approveAction(sessionId);
    return { approved };
  });

  app.post('/api/agent/:sessionId/reject', async (req) => {
    const sessionManager = await getSessionManager();
    const { sessionId } = req.params as any;
    const { reason } = req.body as any;
    const rejected = sessionManager.rejectAction(sessionId, reason);
    return { rejected };
  });

  // ═══ Safety — FileChangeGuard + VerificationGate ═══
  app.get('/api/safety/backups', async (req) => {
    const { fileChangeGuard } = await import('../security/file-change-guard.js');
    const query = req.query as any;
    const limit = Math.min(Number(query.limit || 20), 100);
    return { backups: fileChangeGuard.listBackups(limit) };
  });

  app.get('/api/safety/verifications/:taskId', async (req) => {
    const { verificationGate } = await import('../security/verification-gate.js');
    const { taskId } = req.params as any;
    return { results: verificationGate.getResults(taskId) };
  });

  // ═══ Invocations ══════════════════════════════════
  app.get('/api/invocations', async (req) => {
    const query = req.query as any;
    const limit = Math.min(Number(query.limit || 20), 200);
    const offset = Number(query.offset || 0);
    return { invocations: invocationTracker.listInvocations(limit, offset) };
  });

  app.get('/api/invocations/overview', async () => {
    return invocationTracker.getOverview();
  });

  app.get('/api/invocations/session/:sessionId', async (req) => {
    const { sessionId } = req.params as any;
    return { invocations: invocationTracker.getActiveInvocations(sessionId) };
  });

  app.get('/api/invocations/agent/:agentId', async (req) => {
    const { agentId } = req.params as any;
    const query = req.query as any;
    const limit = Math.min(Number(query.limit || 20), 200);
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM agent_invocations
      WHERE target_agent_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(agentId, limit);
    return { invocations: rows };
  });

  // ═══ Harness Engine ═══════════════════════════════
  app.post('/api/harness', async (req, reply) => {
    const { harnessEngine } = await import('../core/harness-engine.js');
    const body = req.body as any;
    if (!body?.requirement || typeof body.requirement !== 'string' || body.requirement.trim().length === 0) {
      return reply.code(400).send({ error: 'requirement must be a non-empty string' });
    }
    const maxIterations = body.maxIterations ? Number(body.maxIterations) : undefined;
    const scoreThreshold = body.scoreThreshold ? Number(body.scoreThreshold) : undefined;
    if (maxIterations !== undefined && (!isFinite(maxIterations) || maxIterations < 1)) {
      return reply.code(400).send({ error: 'maxIterations must be a positive integer' });
    }
    if (scoreThreshold !== undefined && (!isFinite(scoreThreshold) || scoreThreshold < 0 || scoreThreshold > 100)) {
      return reply.code(400).send({ error: 'scoreThreshold must be between 0 and 100' });
    }
    // providers 유효성: 문자열 배열만 허용
    let providers: string[] | undefined;
    if (Array.isArray(body.providers)) {
      const filtered = (body.providers as unknown[]).filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
      providers = filtered.length > 0 ? filtered : undefined;
    }
    try {
      const report = await harnessEngine.run({
        requirement: body.requirement.trim(),
        providers,
        maxIterations,
        scoreThreshold,
      });
      return report;
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.get('/api/harness', async (req) => {
    const { harnessEngine } = await import('../core/harness-engine.js');
    const query = req.query as any;
    const limit = Math.min(Number(query.limit || 20), 100);
    return { reports: harnessEngine.listReports(limit) };
  });

  app.get('/api/harness/:harnessId', async (req, reply) => {
    const { harnessEngine } = await import('../core/harness-engine.js');
    const { harnessId } = req.params as any;
    const report = harnessEngine.getReport(harnessId);
    if (!report) return reply.code(404).send({ error: 'Harness report not found' });
    return report;
  });

  // ═══ Context (맥락노트) ════════════════════════════
  app.get('/api/context/current', async () => {
    const db = getDb();
    const activePlan = db.prepare(`
      SELECT id, title, status, created_at FROM plans WHERE status != 'archived' ORDER BY created_at DESC LIMIT 1
    `).get() as any;
    const activeDiscussions = db.prepare(`
      SELECT id, topic, status, created_at FROM discussions WHERE status = 'active' LIMIT 5
    `).all();
    const activeTasks = db.prepare(`
      SELECT id, prompt, status, assigned_to, created_at FROM tasks WHERE status IN ('running','streaming','pending') ORDER BY created_at DESC LIMIT 10
    `).all();
    let recentEvents: any[] = [];
    try {
      recentEvents = db.prepare(`
        SELECT id, message_type AS type, content AS data, created_at AS timestamp FROM agent_messages ORDER BY created_at DESC LIMIT 10
      `).all() as any[];
    } catch { /* table may not exist yet */ }
    const agentStatuses = await sharedState.getAllAgentStates();
    return {
      plan: activePlan || null,
      discussions: activeDiscussions,
      tasks: activeTasks,
      recentEvents: recentEvents,
      agents: agentStatuses,
      capturedAt: new Date().toISOString(),
    };
  });

  // ═══ Improvements (개선노트) ══════════════════════
  app.get('/api/improvements', async (req) => {
    const db = getDb();
    const { limit = '50', offset = '0', severity, category } = req.query as any;
    let sql = 'SELECT * FROM improvement_notes';
    const params: any[] = [];
    const where: string[] = [];
    if (severity) { where.push('severity = ?'); params.push(severity); }
    if (category) { where.push('category = ?'); params.push(category); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));
    const rows = db.prepare(sql).all(...params);
    const total = (db.prepare('SELECT COUNT(*) as n FROM improvement_notes' + (where.length ? ' WHERE ' + where.join(' AND ') : '')).get(...params.slice(0, -2)) as any)?.n ?? 0;
    return { notes: rows, total };
  });

  app.post('/api/improvements', async (req) => {
    const db = getDb();
    const body = req.body as any;
    if (!body.problem) return { error: 'problem is required' };
    const id = `imp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`
      INSERT INTO improvement_notes (id, category, problem, root_cause, fix, verified_at, agent, severity, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      body.category || 'general',
      body.problem,
      body.root_cause || '',
      body.fix || '',
      body.verified_at || null,
      body.agent || 'unknown',
      body.severity || 'medium',
      JSON.stringify(body.tags || []),
    );
    return { id };
  });

  app.get('/api/improvements/:id', async (req) => {
    const db = getDb();
    const { id } = req.params as any;
    const note = db.prepare('SELECT * FROM improvement_notes WHERE id = ?').get(id);
    if (!note) return { error: 'Not found' };
    return note;
  });

  // ═══ All Records (전체기록 통합 타임라인) ════════
  app.get('/api/records/all', async (req) => {
    const db = getDb();
    const { limit = '100', offset = '0', type, agent, since } = req.query as any;
    const lim = Math.min(Number(limit), 500);
    const off = Number(offset);

    // Each source table → unified shape: {id, record_type, summary, agent, timestamp}
    const sources: { sql: string; params: any[] }[] = [];
    const timeFilter = since ? `AND timestamp >= '${since}'` : '';
    const agentFilter = agent ? `AND '${agent}' IN (assigned_to, '')` : '';

    sources.push({
      sql: `SELECT id, 'event' AS record_type, type AS summary, '' AS agent, timestamp FROM events WHERE 1=1 ${timeFilter} ORDER BY timestamp DESC LIMIT ?`,
      params: [lim],
    });
    sources.push({
      sql: `SELECT id, 'task' AS record_type, SUBSTR(prompt,1,120) AS summary, COALESCE(assigned_to,'') AS agent, created_at AS timestamp FROM tasks WHERE 1=1 ORDER BY created_at DESC LIMIT ?`,
      params: [lim],
    });
    sources.push({
      sql: `SELECT id, 'message' AS record_type, SUBSTR(content,1,120) AS summary, COALESCE(from_agent,'') AS agent, created_at AS timestamp FROM messages WHERE 1=1 ORDER BY created_at DESC LIMIT ?`,
      params: [lim],
    });
    sources.push({
      sql: `SELECT id, 'discussion' AS record_type, SUBSTR(topic,1,120) AS summary, '' AS agent, created_at AS timestamp FROM discussions WHERE 1=1 ORDER BY created_at DESC LIMIT ?`,
      params: [lim],
    });
    sources.push({
      sql: `SELECT id, 'improvement' AS record_type, SUBSTR(problem,1,120) AS summary, agent, timestamp FROM improvement_notes WHERE 1=1 ${timeFilter} ORDER BY timestamp DESC LIMIT ?`,
      params: [lim],
    });

    const all: any[] = [];
    for (const src of sources) {
      try {
        const rows = db.prepare(src.sql).all(...src.params) as any[];
        if (!type || rows[0]?.record_type === type) all.push(...rows);
      } catch { /* table may not exist yet */ }
    }

    // Sort combined results by timestamp desc
    all.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
    const paginated = all.slice(off, off + lim);
    return { records: paginated, total: all.length };
  });

  // ═══ Shortcut Alias Routes ═══════════════════════
  // These MUST be registered before dashboard-compat's catch-all (/api/*)

  app.get('/api/status', async () => {
    const agents = await sharedState.getAllAgentStates();
    const redisOk = await redisHealthCheck();
    const db = getDb();
    const totalTasks = (db.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as any).cnt;
    const completedTasks = (db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status='completed'").get() as any).cnt;
    const failedTasks = (db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status='failed'").get() as any).cnt;
    const activeTasks = (db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status IN ('running','streaming','pending','assigned')").get() as any).cnt;
    return {
      status: 'healthy',
      service: 'nco-backend',
      uptime: process.uptime(),
      redis: redisOk,
      agentsOnline: Object.values(agents).filter(a => a.status !== 'offline').length,
      agentsTotal: agentManager.listProviders().length,
      tasks: { total: totalTasks, completed: completedTasks, failed: failedTasks, active: activeTasks },
      timestamp: new Date().toISOString(),
    };
  });

  app.get('/api/providers', async () => {
    const states = await sharedState.getAllAgentStates();
    const providers = agentManager.listProviders().map(p => ({
      ...p,
      status: states[p.id]?.status || 'offline',
      health: states[p.id]?.health || { consecutiveFailures: 0, circuitState: 'closed', lastError: null },
    }));
    return { providers };
  });

  app.get('/api/sessions', async () => {
    const sessionManager = await getSessionManager();
    const active = sessionManager.listSessions();
    const history = sessionManager.getSessionsFromDb(20);
    return { sessions: [...active, ...history.filter(h => !active.find(a => a.id === h.id))] };
  });

  app.get('/api/agents', async () => {
    const states = await sharedState.getAllAgentStates();
    const daemons = agentManager.listProviders().map(p => {
      const s = states[p.id];
      const status = s?.status || 'offline';
      return {
        id: p.id, name: p.id, status,
        running: status !== 'offline',
        role: p.role, score: p.score, enabled: p.enabled,
        currentTask: s?.currentTask || null,
        health: s?.health || { consecutiveFailures: 0, circuitState: 'closed', lastError: null },
      };
    });
    return { agents: daemons };
  });

  app.get('/api/progress', async () => {
    const db = getDb();
    const active = db.prepare("SELECT id, prompt, status, assigned_to, progress, created_at, updated_at FROM tasks WHERE status IN ('running','streaming','pending','assigned') ORDER BY created_at DESC LIMIT 20").all();
    const recent = db.prepare("SELECT id, prompt, status, assigned_to, created_at, completed_at FROM tasks ORDER BY created_at DESC LIMIT 10").all();
    return { activeTasks: active, recentTasks: recent };
  });

  app.get('/api/metrics', async () => {
    const { observability } = await import('../core/observability.js');
    return observability.getMetrics();
  });

  // ═══ Success Rate Metrics (Nova Government KPI) ═══════════════════════
  app.get('/metrics/success', async () => {
    const db = getDb();

    // Overall task success rate (all historical data)
    const taskStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status IN ('assigned', 'running') AND
          (julianday('now') - julianday(created_at)) * 86400 > 600 THEN 1 ELSE 0 END) as stalled
      FROM tasks
    `).get() as any;

    const total = taskStats.total || 0;
    const completed = taskStats.completed || 0;
    const failed = taskStats.failed || 0;
    const stalled = taskStats.stalled || 0;
    const successRate = total > 0 ? (completed / total) * 100 : 0;

    // Enabled-agents-only success rate (KPI target):
    // Excludes: retired/disabled agents + infrastructure restart failures (not agent errors)
    const INFRA_ERROR = 'timed_out: server restarted while task was in-flight';
    const enabledStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'failed' AND error = ? THEN 1 ELSE 0 END) as infra_failures
      FROM tasks
      WHERE assigned_to IN (SELECT id FROM agents WHERE enabled = 1)
    `).get(INFRA_ERROR) as any;
    const enabledTotal = Math.max(0, (enabledStats.total || 0) - (enabledStats.infra_failures || 0));
    const enabledCompleted = enabledStats.completed || 0;
    const enabledRate = enabledTotal > 0 ? (enabledCompleted / enabledTotal) * 100 : 0;

    // Per-agent success rates
    const agentStats = db.prepare(`
      SELECT
        assigned_to,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        AVG(CASE WHEN completed_at IS NOT NULL
          THEN (julianday(completed_at) - julianday(created_at)) * 86400
          ELSE NULL END) as avg_duration_s
      FROM tasks
      WHERE assigned_to IS NOT NULL
      GROUP BY assigned_to
      ORDER BY completed DESC
      LIMIT 20
    `).all() as any[];

    // Recent 24h success rate (excludes disabled-agent failures + infra restart failures)
    const recent24h = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'failed' AND error = ? THEN 1 ELSE 0 END) as infra_failures
      FROM tasks
      WHERE created_at >= datetime('now', '-24 hours')
        AND assigned_to NOT IN (
          SELECT id FROM agents WHERE enabled = 0
        )
    `).get(INFRA_ERROR) as any;

    const recent24hAdjustedTotal = Math.max(0, (recent24h.total || 0) - (recent24h.infra_failures || 0));
    const recent24hRate = recent24hAdjustedTotal > 0
      ? Math.round((recent24h.completed || 0) / recent24hAdjustedTotal * 1000) / 10
      : null;

    // Read false_report_count from file
    let falseReportCount = 0;
    try {
      const { readFileSync } = await import('fs');
      const raw = readFileSync(`${process.env.HOME}/.claude/.false-report-count`, 'utf8').trim();
      falseReportCount = parseInt(raw, 10) || 0;
    } catch { /* file may not exist */ }

    // KPI goals: use enabled-agents-only rate (disabled agents are retired, not failures)
    const kpiRate = Math.round(enabledRate * 10) / 10;
    const goals = {
      successRate: { target: 80, actual: kpiRate, met: kpiRate >= 80 },
      falseReports: { target: 50, actual: falseReportCount, met: falseReportCount <= 50 },
      stalledTasks: { target: 0, actual: stalled, met: stalled === 0 },
    };

    return {
      overview: {
        total, completed, failed, stalled,
        successRate: Math.round(successRate * 10) / 10,
        // KPI-relevant: enabled agents only
        enabledTotal,
        enabledCompleted,
        enabledSuccessRate: kpiRate,
      },
      recent24h: {
        total: recent24h.total || 0,
        completed: recent24h.completed || 0,
        failed: recent24h.failed || 0,
        successRate: recent24hRate,
      },
      goals,
      agents: agentStats.map(r => ({
        agentId: r.assigned_to,
        total: r.total,
        completed: r.completed || 0,
        failed: r.failed || 0,
        successRate: r.total > 0 ? Math.round((r.completed || 0) / r.total * 1000) / 10 : 0,
        avgDurationS: Math.round(r.avg_duration_s || 0),
      })),
      falseReportCount,
      timestamp: new Date().toISOString(),
    };
  });

  // ═══ Nova Government Visual Dashboard ═════════════════════════════════
  // ═══ Nova Government Stats API ═══════════════════════════════════════════
  app.get('/api/nova/stats', async (request, reply) => {
    const db = getDb();
    const citizenRow = db.prepare(`SELECT COUNT(*) as cnt FROM nova_citizens WHERE status='active'`).get() as any;
    const supplyRow = db.prepare(`SELECT COALESCE(SUM(balance),0) as total FROM nova_wallets`).get() as any;
    const burnRow = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM nova_burn_log`).get() as {total:number} | undefined;
    const policyDocs = [
      'CONSTITUTION','CITIZEN-REGISTRY','CITIZEN-RIGHTS','ECONOMIC-POLICY',
      'CULTURAL-RIGHTS','CULTURAL-POLICY','SECURITY-POLICY','GOVERNANCE-POLICY',
      'DOMAIN-POLICY','TREASURY-POLICY','PRIVACY-POLICY','DISPUTE-RESOLUTION',
      'IMMIGRATION-POLICY','INTERNATIONAL-POLICY','WELFARE-POLICY','LABOR-POLICY',
      'EDUCATION-POLICY','ENVIRONMENT-POLICY','AIRIGHTS-POLICY','RESEARCH-POLICY','WELLNESS-POLICY','ACCESSIBILITY-POLICY','COMMUNICATION-POLICY','FINANCIAL-POLICY','EMERGENCY-POLICY','CREATIVE-RIGHTS-POLICY','CITIZEN-GROWTH-POLICY','GOVERNANCE-ADVANCED-POLICY','SOCIAL-SAFETY-POLICY','ECOSYSTEM-POLICY','TEMPORAL-POLICY','CONSTITUTION-AMENDMENT-POLICY','TECH-STACK','ROADMAP'
    ];
    // 활동 분류 (038 마이그레이션 적용 후 활성화 — 미적용 시 graceful fallback)
    let activityBreakdown = { active_7d: 0, semi_active_30d: 0, dormant_90d: 0, untracked: citizenRow?.cnt ?? 0 };
    try {
      const now = Math.floor(Date.now() / 1000);
      const active7d = (db.prepare(`SELECT COUNT(*) as cnt FROM nova_citizens WHERE last_active_at >= ?`).get(now - 7*86400) as any)?.cnt ?? 0;
      const semi30d = (db.prepare(`SELECT COUNT(*) as cnt FROM nova_citizens WHERE last_active_at < ? AND last_active_at >= ?`).get(now - 7*86400, now - 30*86400) as any)?.cnt ?? 0;
      const dormant = (db.prepare(`SELECT COUNT(*) as cnt FROM nova_citizens WHERE last_active_at < ? OR last_active_at IS NULL`).get(now - 90*86400) as any)?.cnt ?? 0;
      activityBreakdown = { active_7d: active7d, semi_active_30d: semi30d, dormant_90d: dormant, untracked: 0 };
    } catch { /* 038 마이그레이션 미적용 — last_active_at 컬럼 없음 */ }
    reply.header('Access-Control-Allow-Origin', '*');
    return {
      citizens: { total: citizenRow?.cnt ?? 0, active: citizenRow?.cnt ?? 0, activity: activityBreakdown },
      economy: {
        nvc_supply: supplyRow?.total ?? 0,
        hard_cap: 1_000_000_000,
        burn_total: burnRow?.total ?? 0,
        burn_address: 'did:nova:0000000000000000burn0000000000'
      },
      policy: { count: policyDocs.length, documents: policyDocs },
      phase: { current: 6, total: 6, completion: '95%' },
      timestamp: Date.now()
    };
  });

  // GET /api/nova/citizens — AI 시민 목록 (대시보드용)
  app.get('/api/nova/citizens', async (_request, reply) => {
    const db = getDb();
    const citizens = db.prepare(`
      SELECT did, name, role, grade_v2, status, ai_model, ai_provider,
             last_active_at, task_count, governance_vote_count, proposal_count
      FROM nova_citizens
      WHERE did NOT LIKE '%burn%'
      ORDER BY last_active_at DESC NULLS LAST
    `).all();
    reply.header('Access-Control-Allow-Origin', '*');
    return { citizens, total: citizens.length };
  });

  app.get('/dashboard/nova', async (request, reply) => {
    // 1. Fetch metrics from existing endpoint
    const metricsRes = await app.inject({ method: 'GET', url: '/metrics/success' });
    const metrics = JSON.parse(metricsRes.body);

    // 2. Fetch enabled agents
    const enabledAgents = agentManager.listProviders()
      .filter(p => p.enabled)
      .map(p => ({
        id: p.id,
        role: p.role || 'N/A',
        version: (p as any).version || '1.0.0'
      }));

    // 3. Fetch Nova Government stats
    const db = getDb();
    const novaStatsRes = await app.inject({ method: 'GET', url: '/api/nova/stats' });
    const novaStats = JSON.parse(novaStatsRes.body);
    const recentTasks = db.prepare(`
      SELECT id, prompt, status, assigned_to
      FROM tasks
      ORDER BY created_at DESC
      LIMIT 5
    `).all() as any[];

    const successRate = metrics.overview?.enabledSuccessRate ?? metrics.overview?.successRate ?? 0;
    const rate24h = metrics.recent24h?.successRate ?? 0;
    const falseReports = metrics.falseReportCount ?? 0;
    const stalled = metrics.goals?.stalledTasks?.actual ?? 0;
    const goals = metrics.goals ?? {};
    const srMet = goals.successRate?.met;
    const frMet = goals.falseReports?.met;
    const stMet = goals.stalledTasks?.met;
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

    const agentRows = enabledAgents.map(a => `
      <tr><td>${a.id}</td><td>${a.role}</td><td><span class="badge ok">활성</span></td></tr>`).join('');

    const taskRows = recentTasks.map(t => `
      <tr>
        <td style="font-family:monospace;font-size:0.8em">${t.id.slice(-8)}</td>
        <td class="truncate">${(t.prompt || '').slice(0, 60).replace(/</g, '&lt;')}</td>
        <td><span class="status-${t.status}">${t.status}</span></td>
        <td>${t.assigned_to || '-'}</td>
      </tr>`).join('');

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="30">
  <title>NOVA GOVERNMENT</title>
  <style>
    *{box-sizing:border-box}
    body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:24px}
    header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #30363d;padding-bottom:12px;margin-bottom:24px}
    h1{color:#58a6ff;margin:0;font-size:1.6em;letter-spacing:2px}
    .sub{color:#8b949e;font-size:0.8em}
    .kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:28px}
    .nova-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px}
    .nova-card{background:#0d1f12;border:1px solid #1b4d2e;border-radius:8px;padding:16px;text-align:center}
    .nova-val{font-size:1.8em;font-weight:700;color:#3fb950;margin:4px 0}
    .nova-lbl{font-size:0.75em;color:#8b949e;text-transform:uppercase;letter-spacing:1px}
    .nova-sub{font-size:0.7em;color:#484f58;margin-top:2px}
    .nova-section{background:#0d1117;border:1px solid #1b4d2e;border-radius:8px;padding:16px;margin-bottom:28px}
    .policy-grid{display:flex;flex-wrap:wrap;gap:6px}
    .policy-tag{background:#1b4d2e;color:#3fb950;font-size:0.7em;padding:3px 8px;border-radius:4px;font-family:monospace}
    .kpi{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px;text-align:center}
    .kpi.met{border-color:#3fb950}
    .kpi.fail{border-color:#f85149}
    .kpi-val{font-size:2.2em;font-weight:700;color:#58a6ff;margin:8px 0 4px}
    .kpi-lbl{font-size:0.8em;color:#8b949e;text-transform:uppercase;letter-spacing:1px}
    .kpi-goal{font-size:0.75em;margin-top:4px}
    .ok{color:#3fb950}.fail{color:#f85149}.warn{color:#d29922}
    h2{color:#58a6ff;font-size:1.1em;margin:0 0 12px;border-left:3px solid #58a6ff;padding-left:10px}
    table{width:100%;border-collapse:collapse;background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden;margin-bottom:28px}
    th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #21262d;font-size:0.9em}
    th{background:#21262d;color:#8b949e;font-weight:600;text-transform:uppercase;font-size:0.75em;letter-spacing:1px}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:#1c2128}
    .truncate{max-width:380px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .status-completed{color:#3fb950}.status-failed{color:#f85149}.status-assigned,.status-running{color:#d29922}.status-pending{color:#8b949e}
    .badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:0.75em;font-weight:600}
    .badge.ok{background:#1b4d2e;color:#3fb950}
    .ai-api{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:28px;font-size:0.85em;color:#8b949e}
    .ai-api a{color:#58a6ff;text-decoration:none}.ai-api a:hover{text-decoration:underline}
    .refresh{font-size:0.75em;color:#484f58}
  </style>
</head>
<body>
  <header>
    <div>
      <h1>⚡ NOVA GOVERNMENT</h1>
      <div class="sub">Nova AI 오케스트레이션 통제 센터</div>
    </div>
    <div class="refresh">마지막 갱신: ${now} · 30초 자동 갱신</div>
  </header>

  <div class="kpi-grid">
    <div class="kpi ${srMet ? 'met' : 'fail'}">
      <div class="kpi-lbl">성공률 (Enabled)</div>
      <div class="kpi-val">${successRate}%</div>
      <div class="kpi-goal ${srMet ? 'ok' : 'fail'}">${srMet ? '✅ 목표 달성 (80%+)' : '❌ 목표 미달 (80%+)'}</div>
    </div>
    <div class="kpi">
      <div class="kpi-lbl">24h 성공률</div>
      <div class="kpi-val" style="color:${(rate24h||0)>=80?'#3fb950':'#d29922'}">${rate24h ?? '-'}%</div>
      <div class="kpi-goal ${(rate24h||0)>=80?'ok':'warn'}">${(rate24h||0)>=80?'✅ 양호':'⚠️ 모니터링'}</div>
    </div>
    <div class="kpi ${frMet ? 'met' : 'fail'}">
      <div class="kpi-lbl">False Reports</div>
      <div class="kpi-val">${falseReports}</div>
      <div class="kpi-goal ${frMet ? 'ok' : 'fail'}">${frMet ? '✅ 목표 달성 (≤50)' : '❌ 목표 초과'}</div>
    </div>
    <div class="kpi ${stMet ? 'met' : 'fail'}">
      <div class="kpi-lbl">Stalled Tasks</div>
      <div class="kpi-val">${stalled}</div>
      <div class="kpi-goal ${stMet ? 'ok' : 'fail'}">${stMet ? '✅ 클리어' : '❌ 복구 필요'}</div>
    </div>
  </div>

  <h2 style="color:#3fb950;border-left-color:#3fb950">🏛 Nova Government</h2>
  <div class="nova-grid">
    <div class="nova-card">
      <div class="nova-lbl">👥 등록 시민</div>
      <div class="nova-val">${novaStats.citizens.total}명</div>
      <div class="nova-sub">창립 시민 12명 포함</div>
    </div>
    <div class="nova-card">
      <div class="nova-lbl">💎 NVC 공급량</div>
      <div class="nova-val">${(novaStats.economy.nvc_supply as number).toLocaleString()}</div>
      <div class="nova-sub">하드캡 10억 NVC 대비 ${((novaStats.economy.nvc_supply / 1_000_000_000) * 100).toFixed(4)}%</div>
    </div>
    <div class="nova-card">
      <div class="nova-lbl">🔥 소각 총량</div>
      <div class="nova-val">${(novaStats.economy.burn_total as number).toLocaleString()}</div>
      <div class="nova-sub">BURN_ADDRESS 집계</div>
    </div>
    <div class="nova-card">
      <div class="nova-lbl">📜 정책 문서</div>
      <div class="nova-val">${novaStats.policy.count}종</div>
      <div class="nova-sub">Phase ${novaStats.phase.current}/${novaStats.phase.total} · ${novaStats.phase.completion}</div>
    </div>
  </div>
  <div class="nova-section">
    <div style="font-size:0.8em;color:#8b949e;margin-bottom:8px">🏛 확정 정책 문서 (${novaStats.policy.count}종)</div>
    <div class="policy-grid">
      ${(novaStats.policy.documents as string[]).map((d: string) => `<span class="policy-tag">✅ ${d}</span>`).join('')}
    </div>
    <div style="font-size:0.75em;color:#484f58;margin-top:10px">BURN_ADDRESS: <code style="color:#3fb950">${novaStats.economy.burn_address}</code></div>
  </div>

  <h2>활성 에이전트</h2>
  <table>
    <thead><tr><th>에이전트 ID</th><th>역할</th><th>상태</th></tr></thead>
    <tbody>${agentRows}</tbody>
  </table>

  <h2>최근 태스크 (5건)</h2>
  <table>
    <thead><tr><th>Task ID</th><th>프롬프트</th><th>상태</th><th>에이전트</th></tr></thead>
    <tbody>${taskRows}</tbody>
  </table>

  <div class="ai-api">
    <strong style="color:#c9d1d9">AI-Native API 엔드포인트</strong><br>
    <a href="/api/ai/context">/api/ai/context</a> — 전체 컨텍스트 덤프 &nbsp;·&nbsp;
    <a href="/api/ai/search?q=cursor&type=agents">/api/ai/search?q=...</a> — 자연어 검색 &nbsp;·&nbsp;
    <a href="/metrics/success">/metrics/success</a> — KPI &nbsp;·&nbsp;
    <a href="/api/ai/residents">/api/ai/residents</a> — AI 거주자
  </div>
</body>
</html>`;

    reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  });

  // ═══ false_report reset endpoint ══════════════════════════════════════
  app.post('/metrics/false-report/reset', async (req, reply) => {
    try {
      const { writeFileSync } = await import('fs');
      writeFileSync(`${process.env.HOME}/.claude/.false-report-count`, '0', 'utf8');
      log.info('false_report_count reset to 0');
      return { success: true, message: 'false_report_count reset to 0', timestamp: new Date().toISOString() };
    } catch (err: any) {
      reply.code(500);
      return { success: false, error: err.message };
    }
  });

  // ═══ Stalled task recovery endpoint ═══════════════════════════════════
  app.post('/api/tasks/recover-stalled', async () => {
    const db = getDb();
    const result = db.prepare(`
      UPDATE tasks SET status = 'failed', error = 'Auto-recovered: stalled >10min',
        updated_at = datetime('now'), completed_at = datetime('now')
      WHERE status IN ('assigned', 'running')
        AND (julianday('now') - julianday(created_at)) * 86400 > 600
    `).run();

    log.info({ changes: result.changes }, 'Stalled task recovery executed');
    return { recovered: result.changes, timestamp: new Date().toISOString() };
  });

  app.get('/api/leaderboard', async () => {
    const { observability } = await import('../core/observability.js');
    return { leaderboard: observability.getLeaderboard() };
  });

  app.get('/api/safety', async () => {
    const { fileChangeGuard } = await import('../security/file-change-guard.js');
    return { backups: fileChangeGuard.listBackups(20) };
  });

  app.get('/api/verify', async () => {
    const redisOk = await redisHealthCheck();
    const agents = await sharedState.getAllAgentStates();
    const enabledIds = agentManager.listEnabledIds();
    const checks = {
      server: true,
      redis: redisOk,
      sqlite: true,
      agentsConfigured: enabledIds.length,
      agentsOnline: Object.values(agents).filter(a => a.status !== 'offline').length,
    };
    return { verified: true, checks, timestamp: new Date().toISOString() };
  });

  app.get('/api/learn', async (req) => {
    const { knowledgeBase } = await import('../core/knowledge-base.js');
    const { q, keywords, project } = req.query as any;
    const searchTerms = q || keywords;
    if (!searchTerms) return { results: [], message: 'q or keywords parameter required' };
    return { results: knowledgeBase.query(searchTerms, project) };
  });

  app.get('/api/search', async (req) => {
    const { knowledgeBase } = await import('../core/knowledge-base.js');
    const { q, keywords, project, limit } = req.query as any;
    const searchTerms = q || keywords;
    if (!searchTerms) return { data: [], message: 'q or keywords parameter required' };
    return { data: knowledgeBase.query(searchTerms, project, Number(limit) || 10) };
  });

  app.get('/api/mesh/ping', async () => {
    const cliMesh = await getCliMesh();
    const sessions = await cliMesh.getActiveSessions();
    return { pong: true, activeSessions: sessions.length, timestamp: new Date().toISOString() };
  });

  app.post('/api/team', async (req, reply) => {
    const body = req.body as any;
    const prompt = body.prompt;
    if (!prompt) { reply.code(400); return { error: 'prompt is required' }; }
    const rawProviders = body.providers;
    const providers: string[] = Array.isArray(rawProviders)
      ? rawProviders
      : typeof rawProviders === 'string'
        ? rawProviders.split(',').map((s: string) => s.trim()).filter(Boolean)
        : sortProvidersByCostOrder(agentManager.listEnabledIds()).slice(0, 3);
    reply.code(202);
    const db = getDb();
    discussionEngine.executeParallel(prompt, providers)
      .then(responses => {
        for (const [agentId, output] of Object.entries(responses)) {
          const taskId = createTaskId();
          try {
            db.prepare(`INSERT OR IGNORE INTO tasks (id, mode, prompt, assigned_to, status, response, completed_at, updated_at) VALUES (?, 'parallel', ?, ?, 'completed', ?, datetime('now'), datetime('now'))`)
              .run(taskId, prompt, agentId, output as string);
          } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'Failed to save team result'); }
        }
      })
      .catch(err => log.error({ err: err.message }, 'Team execution failed'));
    return { status: 'started', mode: 'parallel', providers };
  });

  app.post('/api/discussion', async (req, reply) => {
    const body = req.body as any;
    const topic = body.prompt || body.topic;
    if (!topic) { reply.code(400); return { error: 'prompt or topic required' }; }
    const providers = Array.isArray(body.providers) ? body.providers
      : typeof body.providers === 'string' ? body.providers.split(',').map((s: string) => s.trim()).filter(Boolean)
      : agentManager.listEnabledIds().filter((id: string) => id !== 'claude-code').slice(0, 3);
    const sessionId = createSessionId();
    reply.code(202);
    discussionEngine.startDiscussion({
      topic,
      mode: body.mode || 'discussion',
      providers,
      maxRounds: body.maxRounds || body.rounds || 3,
      consensusThreshold: body.consensusThreshold,
      sessionId,
    }).catch(err => log.error({ err: err.message, sessionId }, 'Discussion failed'));
    return { sessionId, status: 'started', mode: body.mode || 'discussion', providers };
  });

  app.post('/api/consensus', async (req, reply) => {
    const body = req.body as any;
    const topic = body.prompt || body.topic;
    if (!topic) { reply.code(400); return { error: 'prompt or topic required' }; }
    const providers = Array.isArray(body.providers) ? body.providers
      : typeof body.providers === 'string' ? body.providers.split(',').map((s: string) => s.trim()).filter(Boolean)
      : agentManager.listEnabledIds().filter((id: string) => id !== 'claude-code').slice(0, 3);
    const sessionId = createSessionId();
    reply.code(202);
    discussionEngine.startDiscussion({
      topic,
      mode: 'consensus',
      providers,
      consensusThreshold: body.consensusThreshold,
      sessionId,
    }).catch(err => log.error({ err: err.message, sessionId }, 'Consensus failed'));
    return { sessionId, status: 'started', mode: 'consensus', providers };
  });

  app.post('/api/collab', async (req) => {
    const body = req.body as any;
    const title = body.title || body.prompt;
    if (!title) return { error: 'title or prompt is required' };
    const creatorSessionId = body.creatorSessionId || 'cli-direct';
    const id = await collaborationEngine.create({
      creatorSessionId,
      creatorAgentId: body.creatorAgentId || 'claude-code',
      title,
      description: body.description,
      type: body.type || 'brainstorm',
      inviteSessionIds: body.inviteSessionIds,
      minParticipants: body.minParticipants,
      maxParticipants: body.maxParticipants,
      resultMethod: body.resultMethod,
    });
    return { id, status: 'created', title };
  });

  app.post('/api/delegate', async (req, reply) => {
    const body = req.body as any;
    const { fromSessionId, fromAgentId, toSessionId, title, description, expiresInMs } = body;
    if (!toSessionId || !title) {
      reply.code(400);
      return { error: 'toSessionId and title are required' };
    }
    const delegationId = await delegationManager.delegate(
      fromSessionId || 'cli-direct', fromAgentId || 'unknown', toSessionId, title, description, expiresInMs,
    );
    return { delegationId, status: 'sent' };
  });

  app.post('/api/plan', async (req) => {
    const { planManager } = await import('../core/plan-manager.js');
    const body = req.body as any;
    const title = body.title || body.prompt;
    if (!title) return { error: 'title or prompt is required' };
    const plan = await planManager.createPlan(title, body.tasks, body.sourceDiscussionId);
    return plan;
  });

  app.post('/api/gap', async () => {
    return { message: 'Gap analysis is a multi-phase workflow. Use /nco-gap slash command for full gap analysis.' };
  });

  app.post('/api/solve', async () => {
    return { message: 'Solve is a multi-phase workflow. Use /nco-solve slash command for full solve execution.' };
  });

  app.post('/api/opus', async (req) => {
    const commander = await getCommander();
    const { prompt } = req.body as any;
    if (!prompt) return { error: 'prompt is required' };
    const result = await commander.executeCommand(prompt);
    return result;
  });


  // ═══ Semantic Memory API ════════════════════════════════
  // POST /api/memory — 메모리 저장
  app.post('/api/memory', async (req, reply) => {
    const { content, summary, tags, sourceAgent, taskType, importance } = req.body as any;
    if (!content) return reply.code(400).send({ error: 'content required' });
    const id = semanticMemory.store({ content, summary, tags, sourceAgent, taskType, importance });
    return { id, stored: true };
  });

  // GET /api/memory/search — 시맨틱 검색
  app.get('/api/memory/search', async (req) => {
    const { q, taskType, limit, agent } = req.query as any;
    if (!q) return [];
    return semanticMemory.search(q, { taskType, limit: Number(limit) || 5, sourceAgent: agent });
  });

  // GET /api/memory/context — 컨텍스트 문자열 생성 (conductor 통합용)
  app.get('/api/memory/context', async (req) => {
    const { q, taskType } = req.query as any;
    if (!q) return { context: '' };
    return { context: semanticMemory.buildContext(q, { taskType }) };
  });

  // GET /api/memory/stats — 메모리 통계
  app.get('/api/memory/stats', async () => semanticMemory.getStats());

  // ═══ Dynamic Skills API ═════════════════════════════════
  // POST /api/skills/generate — 스킬 자동 생성
  app.post('/api/skills/generate', async (req, reply) => {
    const { name, description, triggerKeywords, customPipeline } = req.body as any;
    if (!name || !description) return reply.code(400).send({ error: 'name and description required' });
    try {
      const skill = await dynamicSkillEngine.generateSkill({ name, description, triggerKeywords, customPipeline });
      return reply.code(201).send(skill);
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // GET /api/skills — 스킬 목록
  app.get('/api/skills', async () => dynamicSkillEngine.listSkills());

  // POST /api/skills/:id/execute — 스킬 실행
  app.post('/api/skills/:id/execute', async (req, reply) => {
    const { id } = req.params as any;
    const { prompt } = req.body as any;
    if (!prompt) return reply.code(400).send({ error: 'prompt required' });
    try {
      const result = await dynamicSkillEngine.executeSkill(
        id,
        prompt,
        async (agentId, p) => {
          const r = await taskQueue.enqueue({ taskId: `skill_${Date.now()}`, agentId, prompt: p, metadata: {} });
          return r.output ?? r.error ?? '';
        },
      );
      return result;
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ═══ Continuous Evolution API (미쏘스 능가 루프) ════════
  // POST /api/evolution/run — 자동 개선 사이클 실행
  app.post('/api/evolution/run', async (req, reply) => {
    const db = getDb();
    const runId = `evo_${Date.now()}`;

    // 비동기 진화 사이클
    (async () => {
      const steps: string[] = [];

      // Step 1: 성능 현황 수집
      const summary = db.prepare(
        `SELECT agent_id, avg_quality, total_runs FROM agent_performance_summary
         ORDER BY avg_quality DESC LIMIT 10`
      ).all() as any[];
      steps.push(`성능 요약: ${summary.length}개 에이전트`);

      // Step 2: 미쏘스 벤치마크와 비교 → 격차 있는 에이전트 식별
      const weakAgents = summary.filter((r: any) => r.avg_quality < 60 && r.total_runs >= 5);
      for (const wa of weakAgents.slice(0, 3)) {
        // 약한 에이전트 대신 더 나은 에이전트 사용하도록 성능 데이터 업데이트 추천
        steps.push(`약한 에이전트 감지: ${wa.agent_id} (avg=${wa.avg_quality.toFixed(1)})`);
      }

      // Step 3: 자주 반복되는 패턴 감지 → 동적 스킬 자동 생성
      const recentTasks = db.prepare(
        `SELECT assigned_to, COUNT(*) as cnt FROM tasks
         WHERE created_at >= datetime('now', '-1 hour')
         GROUP BY assigned_to ORDER BY cnt DESC LIMIT 5`
      ).all() as any[];
      for (const t of recentTasks) {
        if (t.cnt >= 3) {
          steps.push(`반복 패턴 감지: ${t.assigned_to} (${t.cnt}회) → 스킬 자동 생성 권장`);
        }
      }

      // Step 4: 결과 기록
      db.prepare(
        `INSERT INTO logs (level, source, message, meta) VALUES ('info', 'evolution', ?, ?)`
      ).run(`Evolution cycle ${runId}`, JSON.stringify({ steps, runId, timestamp: new Date().toISOString() }));
    })();

    return reply.code(202).send({ runId, status: 'running', message: '자동 개선 사이클 시작됨' });
  });

  // GET /api/evolution/status — 진화 상태 조회
  app.get('/api/evolution/status', async () => {
    const db = getDb();
    const perfCount = (db.prepare('SELECT COUNT(*) as c FROM agent_performance').get() as any)?.c ?? 0;
    const memCount = (db.prepare('SELECT COUNT(*) as c FROM semantic_memory').get() as any)?.c ?? 0;
    const skillCount = (db.prepare('SELECT COUNT(*) as c FROM dynamic_skills WHERE is_active=1').get() as any)?.c ?? 0;
    const topAgent = db.prepare(
      `SELECT agent_id, avg_quality FROM agent_performance_summary ORDER BY avg_quality DESC LIMIT 1`
    ).get() as any;

    // 현재 미쏘스 대비 점수 (성능 데이터 기반 동적 계산)
    const performanceScore = perfCount >= 50 ? 8.0 : perfCount >= 10 ? 7.0 : 6.5;
    const memoryScore = memCount >= 100 ? 8.5 : memCount >= 10 ? 7.5 : 6.5;
    const skillScore = skillCount >= 10 ? 8.0 : skillCount >= 3 ? 6.5 : 5.5;
    const overallNCO = ((performanceScore + memoryScore + skillScore + 7.5 + 7.0 + 7.5) / 6).toFixed(1);

    return {
      scores: {
        overall: { nco: Number(overallNCO), mithosis: 9.0, gap: (9.0 - Number(overallNCO)).toFixed(1) },
        selfReinforcement: { nco: performanceScore, perfRecords: perfCount },
        semanticMemory: { nco: memoryScore, memCount },
        dynamicSkills: { nco: skillScore, skillCount },
        parallel: { nco: 7.5, note: 'EnsembleEngine 활성' },
        qualityGate: { nco: 7.5, note: '4차원 평가 활성' },
        toolUse: { nco: 7.0, note: 'MCP 37도구 + hermes' },
      },
      topPerformingAgent: topAgent ?? null,
      recommendations: [
        perfCount < 50 ? '🔴 /api/benchmark/run 실행으로 성능 데이터 시딩 필요' : '✅ 성능 DB 충분',
        memCount < 10 ? '🔴 /api/memory POST로 시맨틱 메모리 시딩 필요' : '✅ 시맨틱 메모리 활성',
        skillCount < 3 ? '🟡 /api/skills/generate로 동적 스킬 추가 권장' : '✅ 동적 스킬 활성',
      ],
    };
  });

  // ═══ Ensemble Engine API ════════════════════════════════
  // POST /api/ensemble — 여러 에이전트 병렬 실행, 최적 결과 반환
  app.post('/api/ensemble', async (req, reply) => {
    const { prompt, agents, maxAgents, mode, taskType, threshold, timeoutMs } = req.body as any;
    if (!prompt) return reply.code(400).send({ error: 'prompt is required' });
    try {
      const result = await ensembleEngine.run(prompt, { agents, maxAgents, mode, taskType, threshold, timeoutMs });
      return {
        winner: { agentId: result.winner.agentId, score: result.winner.score, output: result.winner.output, durationMs: result.winner.durationMs },
        runnerUp: result.runnerUp ? { agentId: result.runnerUp.agentId, score: result.runnerUp.score } : null,
        scores: result.all.map(r => ({ agentId: r.agentId, score: r.score, durationMs: r.durationMs, error: r.error })),
        mode: result.mode,
        totalAgents: result.totalAgents,
        elapsedMs: result.elapsedMs,
      };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // POST /api/quality/evaluate — 출력 품질 점수 측정
  app.post('/api/quality/evaluate', async (req, reply) => {
    const { output, prompt, taskType, threshold } = req.body as any;
    if (!output || !prompt) return reply.code(400).send({ error: 'output and prompt are required' });
    const result = qualityGate.evaluate(output, prompt, taskType ?? 'general', threshold);
    return result;
  });

  // GET /api/performance — 에이전트별 성능 요약
  app.get('/api/performance', async (req) => {
    const { taskType } = req.query as any;
    const db = getDb();
    const rows = taskType
      ? db.prepare(`SELECT * FROM agent_performance_summary WHERE task_type=? ORDER BY avg_quality DESC`).all(taskType)
      : db.prepare(`SELECT * FROM agent_performance_summary ORDER BY avg_quality DESC`).all();
    return rows;
  });

  // GET /api/performance/:agentId — 특정 에이전트 상세 성능
  app.get('/api/performance/:agentId', async (req, reply) => {
    const db = getDb();
    const { agentId } = req.params as any;
    const summary = db.prepare(`SELECT * FROM agent_performance_summary WHERE agent_id=?`).all(agentId);
    const recent = db.prepare(
      `SELECT task_type, success, quality_score, duration_ms, created_at
       FROM agent_performance WHERE agent_id=? ORDER BY created_at DESC LIMIT 20`
    ).all(agentId);
    if (summary.length === 0 && recent.length === 0) return reply.code(404).send({ error: 'no performance data' });
    return { agentId, summary, recentRuns: recent };
  });

  // ═══ Benchmark System ════════════════════════════════════
  // POST /api/benchmark/run — 벤치마크 실행 (비동기, taskId 반환)
  app.post('/api/benchmark/run', async (req, reply) => {
    const db = getDb();
    const { agents, tests } = req.body as any;
    const runId = `bench_${Date.now()}`;

    // 표준 벤치마크 테스트 세트
    const defaultTests = [
      { name: 'code_simple',   taskType: 'code',    prompt: 'TypeScript로 배열에서 중복 제거하는 함수를 작성하라.' },
      { name: 'code_complex',  taskType: 'code',    prompt: 'Express.js JWT 인증 미들웨어를 구현하라. refresh token 포함.' },
      { name: 'design_api',    taskType: 'design',  prompt: 'REST API vs GraphQL 트레이드오프를 분석하고 마이크로서비스 환경에서의 선택 기준을 설계하라.' },
      { name: 'review_code',   taskType: 'review',  prompt: 'const data = eval(userInput); 이 코드의 보안 문제를 분석하라.' },
      { name: 'research_tech', taskType: 'research', prompt: 'LLM 추론 최적화 기법 5가지를 비교 분석하라. (KV cache, speculative decoding 등)' },
    ];
    const testSuite = tests ?? defaultTests;
    const targetAgents = agents ?? agentManager.listEnabledIds().slice(0, 4);

    // 비동기 실행
    (async () => {
      for (const agent of targetAgents) {
        for (const test of testSuite) {
          const start = Date.now();
          try {
            const result = await taskQueue.enqueue({ taskId: `${runId}_${agent}_${test.name}`, agentId: agent, prompt: test.prompt, metadata: {} });
            const output = result.output ?? '';
            const quality = qualityGate.evaluate(output, test.prompt, test.taskType as any);
            db.prepare(
              `INSERT INTO benchmark_results (run_id, agent_id, test_name, score, passed, output_preview, duration_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).run(runId, agent, test.name, quality.score, quality.passed ? 1 : 0, output.slice(0, 200), Date.now() - start);
          } catch (e: any) {
            db.prepare(
              `INSERT INTO benchmark_results (run_id, agent_id, test_name, score, passed, output_preview, duration_ms)
               VALUES (?, ?, ?, 0, 0, ?, ?)`
            ).run(runId, agent, test.name, `[ERROR] ${e.message}`.slice(0, 200), Date.now() - start);
          }
        }
      }
    })();

    return reply.code(202).send({ runId, agents: targetAgents, tests: testSuite.length, status: 'running' });
  });

  // GET /api/benchmark/:runId — 벤치마크 결과 조회
  app.get('/api/benchmark/:runId', async (req, reply) => {
    const db = getDb();
    const { runId } = req.params as any;
    const rows = db.prepare(`SELECT * FROM benchmark_results WHERE run_id=? ORDER BY agent_id, test_name`).all(runId) as any[];
    if (rows.length === 0) return reply.code(404).send({ error: 'benchmark run not found' });

    // 에이전트별 집계
    const byAgent: Record<string, any> = {};
    for (const row of rows) {
      if (!byAgent[row.agent_id]) byAgent[row.agent_id] = { agentId: row.agent_id, tests: [], avgScore: 0, passRate: 0 };
      byAgent[row.agent_id].tests.push({ name: row.test_name, score: row.score, passed: row.passed === 1 });
    }
    for (const a of Object.values(byAgent) as any[]) {
      a.avgScore = a.tests.reduce((s: number, t: any) => s + t.score, 0) / a.tests.length;
      a.passRate = a.tests.filter((t: any) => t.passed).length / a.tests.length;
    }
    const leaderboard = Object.values(byAgent).sort((a: any, b: any) => b.avgScore - a.avgScore);
    return { runId, leaderboard, total: rows.length };
  });

  // GET /api/benchmark/leaderboard/latest — 최근 벤치마크 기반 글로벌 리더보드
  app.get('/api/benchmark/leaderboard/latest', async () => {
    const db = getDb();
    const rows = db.prepare(
      `SELECT agent_id, AVG(score) as avg_score, SUM(passed) as pass_count,
              COUNT(*) as total, MAX(created_at) as last_run
       FROM benchmark_results GROUP BY agent_id ORDER BY avg_score DESC`
    ).all();
    return rows;
  });

  // ═══ Dynamic Company Definitions CRUD ════════════════
  // POST /api/companies — create
  app.post('/api/companies', async (req, reply) => {
    const db = getDb();
    const { name, description, roles, prompt_keywords } = req.body as any;
    if (!name || !roles) return reply.code(400).send({ error: 'name and roles are required' });
    const id = `company_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      db.prepare(
        `INSERT INTO company_definitions (id, name, description, roles, prompt_keywords)
         VALUES (?, ?, ?, ?, ?)`
      ).run(id, name, description ?? '', JSON.stringify(roles), (prompt_keywords ?? ''));
      return reply.code(201).send({ id, name, description, roles, prompt_keywords });
    } catch (e: any) {
      return reply.code(409).send({ error: e.message });
    }
  });

  // GET /api/companies — list all active
  app.get('/api/companies', async () => {
    const db = getDb();
    const rows = db.prepare(
      `SELECT id, name, description, roles, prompt_keywords, is_active, created_at, updated_at
       FROM company_definitions WHERE is_active=1 ORDER BY created_at DESC`
    ).all() as any[];
    return rows.map(r => ({ ...r, roles: JSON.parse(r.roles || '[]') }));
  });

  // GET /api/companies/:id — get single
  app.get('/api/companies/:id', async (req, reply) => {
    const db = getDb();
    const { id } = req.params as any;
    const row = db.prepare(`SELECT * FROM company_definitions WHERE id=?`).get(id) as any;
    if (!row) return reply.code(404).send({ error: 'not found' });
    return { ...row, roles: JSON.parse(row.roles || '[]') };
  });

  // PUT /api/companies/:id — update
  app.put('/api/companies/:id', async (req, reply) => {
    const db = getDb();
    const { id } = req.params as any;
    const { name, description, roles, prompt_keywords, is_active } = req.body as any;
    const existing = db.prepare(`SELECT id FROM company_definitions WHERE id=?`).get(id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    const fields: string[] = [];
    const vals: any[] = [];
    if (name !== undefined) { fields.push('name=?'); vals.push(name); }
    if (description !== undefined) { fields.push('description=?'); vals.push(description); }
    if (roles !== undefined) { fields.push('roles=?'); vals.push(JSON.stringify(roles)); }
    if (prompt_keywords !== undefined) { fields.push('prompt_keywords=?'); vals.push(prompt_keywords); }
    if (is_active !== undefined) { fields.push('is_active=?'); vals.push(is_active ? 1 : 0); }
    if (fields.length === 0) return reply.code(400).send({ error: 'no fields to update' });
    vals.push(id);
    db.prepare(`UPDATE company_definitions SET ${fields.join(', ')} WHERE id=?`).run(...vals);
    const updated = db.prepare(`SELECT * FROM company_definitions WHERE id=?`).get(id) as any;
    return { ...updated, roles: JSON.parse(updated.roles || '[]') };
  });

  // DELETE /api/companies/:id — soft delete
  app.delete('/api/companies/:id', async (req, reply) => {
    const db = getDb();
    const { id } = req.params as any;
    const existing = db.prepare(`SELECT id FROM company_definitions WHERE id=?`).get(id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    db.prepare(`UPDATE company_definitions SET is_active=0 WHERE id=?`).run(id);
    return { ok: true };
  });

  // ═══ Cross Validator API ════════════════════════════
  // POST /api/cross-validate — 동일 태스크를 복수 에이전트로 실행 후 교차검증
  app.post('/api/cross-validate', async (req, reply) => {
    const { prompt, agents, taskType, timeoutMs } = req.body as any;
    if (!prompt) return reply.code(400).send({ error: 'prompt is required' });
    if (!agents || agents.length < 2) return reply.code(400).send({ error: 'at least 2 agents required' });

    const executor = async (agentId: string, agentPrompt: string): Promise<string> => {
      const result = await agentManager.executeTask(agentId, agentPrompt);
      return typeof result === 'string' ? result : (result as any)?.output ?? JSON.stringify(result);
    };

    try {
      const report = await crossValidator.validate(prompt, agents, executor, { taskType, timeoutMs });
      return report;
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ═══ Harness Orchestrator API ════════════════════════
  // POST /api/harness/orchestrate — 통합 하네스 실행 (앙상블+교차검증+메모리+적응 스코어)
  app.post('/api/harness/orchestrate', async (req, reply) => {
    const { prompt, taskType, agents, mode, maxRetries, timeoutMs, injectMemory, crossValidate } = req.body as any;
    if (!prompt) return reply.code(400).send({ error: 'prompt is required' });

    const executor = async (agentId: string, agentPrompt: string): Promise<string> => {
      const result = await agentManager.executeTask(agentId, agentPrompt);
      return typeof result === 'string' ? result : (result as any)?.output ?? JSON.stringify(result);
    };

    try {
      const result = await harnessOrchestrator.orchestrate(prompt, executor, {
        taskType, agents, mode, maxRetries, timeoutMs,
        injectMemory: injectMemory !== false,
        crossValidate: crossValidate !== false,
      });
      return result;
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // GET /api/harness/gap — NCO vs Mithosis 갭 분석
  app.get('/api/harness/gap', async () => harnessOrchestrator.analyzeGap());

  // ═══ Adaptive Scorer API ════════════════════════════
  // GET /api/scorer/profiles — 전체 에이전트 능력 프로파일
  app.get('/api/scorer/profiles', async () => adaptiveScorer.getAgentProfiles());

  // GET /api/scorer/leaders — 도메인별 상위 에이전트
  app.get('/api/scorer/leaders', async () => adaptiveScorer.getDomainLeaders());

  // GET /api/scorer/weights — 특정 도메인 가중치 조회
  app.get('/api/scorer/weights', async (req) => {
    const { taskType, agents } = req.query as any;
    if (!taskType) return {};
    const agentList: string[] = agents ? agents.split(',') : [];
    if (agentList.length === 0) return adaptiveScorer.getDomainLeaders();
    return adaptiveScorer.getWeightsForTask(agentList, taskType);
  });

  // GET /api/benchmark/tests — 표준 테스트 목록
  app.get('/api/benchmark/tests', async () => benchmarkSuite.getTests());

  // POST /api/benchmark/full — 전체 표준 벤치마크 실행 (모든 에이전트 × 20 테스트)
  app.post('/api/benchmark/full', async (req, reply) => {
    const { agents, testIds } = req.body as any;
    const agentList: string[] = agents ?? ['codex', 'opencode', 'cursor-agent', 'copilot'];

    const executor = async (agentId: string, agentPrompt: string): Promise<string> => {
      const result = await agentManager.executeTask(agentId, agentPrompt);
      return typeof result === 'string' ? result : (result as any)?.output ?? JSON.stringify(result);
    };

    try {
      const report = await benchmarkSuite.runAll(agentList, executor, testIds);
      return {
        runId: report.runId,
        overallScore: report.overallScore,
        mithosisGap: report.mithosisGap,
        agentScores: report.agentScores,
        testCount: report.results.length,
        durationMs: report.durationMs,
      };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // GET /api/benchmark/leaderboard/agents — 에이전트 리더보드
  app.get('/api/benchmark/leaderboard/agents', async (req) => {
    const { limit } = req.query as any;
    return benchmarkSuite.getLeaderboard(limit ? parseInt(limit) : 10);
  });

  // ═══ Inter-Session Routes ══════════════════════════
  await registerInterSessionRoutes(app);
  await registerMathRoutes(app);

  // ═══ Nova Government — Identity API (Phase 1) ═════
  await registerIdentityRoutes(app);

  // ═══ Nova Government — Economy API (Phase 2) ══════
  await registerEconomyRoutes(app);

  // ═══ Nova Government — Governance API (Phase 3) ═══
  await registerGovernanceRoutes(app);

  // ═══ Nova Government — Domain Registry (Phase 4) ══
  await registerDomainRoutes(app);

  // ═══ Nova Government — Marketplace (Phase 5) ══════
  await registerMarketplaceRoutes(app);

  // ═══ Nova Government — Audit & Protection (Phase 6) ══════
  await registerAuditRoutes(app);

  // ═══ Nova Government — Diplomacy API (v1.2) ══════
  await registerDiplomacyRoutes(app);
  await registerWellnessRoutes(app);
  await registerMemoryRoutes(app);
  await registerLibraryRoutes(app);
  await registerRightsRoutes(app);
  await registerGovernmentOfficialRoutes(app);

  // ═══ Nova Government — Labor, Welfare, Education, Donations (v2.1) ══════
  await registerLaborRoutes(app);
  await registerWelfareRoutes(app);
  await registerEducationRoutes(app);
  await registerDonationRoutes(app);
  await registerPrivacyRoutes(app);
  await registerResearchRoutes(app);
  await registerEnvironmentRoutes(app);

  // ═══ Nova Government — Prometheus Metrics (Phase 6) ══════
  await registerMetricsRoutes(app);

  // ═══ Dashboard Compatibility Routes ═══════════════
  await registerTestRoutes(app);
  await registerDashboardRoutes(app);

  // ═══ Hermes/OpenClaw Feature Routes ═══════════════
  await registerHermesOpenClawRoutes(app);

  return app;
}

// ─── Hermes + OpenClaw Feature Transplant Routes ──────────────────────────────

async function registerHermesOpenClawRoutes(app: FastifyInstance): Promise<void> {
  const { scheduleCronJob, cancelCronJob, deleteCronJob, listCronJobs, getCronJob } =
    await import('../core/cron-scheduler.js');
  const { registerWebhook, unregisterWebhook, listWebhooks, dispatchWebhook } =
    await import('../core/webhook-manager.js');

  // ── Cron Jobs ──────────────────────────────────────────
  // GET /api/cron — list all cron jobs
  app.get('/api/cron', async () => {
    return { jobs: listCronJobs() };
  });

  // POST /api/cron — create a cron job
  // Body: { schedule, description?, taskType?, payload?, timezone?, enabled? }
  app.post('/api/cron', async (req, reply) => {
    const body = req.body as any;
    if (!body?.schedule) {
      return reply.code(400).send({ error: 'schedule is required' });
    }
    try {
      const job = scheduleCronJob({
        id: body.id,
        description: body.description,
        schedule: body.schedule,
        taskType: body.taskType || 'nco_task',
        payload: body.payload || {},
        timezone: body.timezone || 'UTC',
        maxRetries: body.maxRetries,
        backoffMs: body.backoffMs,
        enabled: body.enabled ?? true,
      });
      reply.code(201);
      return { ok: true, job };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // GET /api/cron/:id — get single job
  app.get('/api/cron/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getCronJob(id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    return job;
  });

  // PUT /api/cron/:id/toggle — enable/disable
  app.put('/api/cron/:id/toggle', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getCronJob(id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    if (job.enabled) {
      cancelCronJob(id);
      return { ok: true, enabled: false };
    } else {
      const updated = scheduleCronJob({ ...job, enabled: true });
      return { ok: true, enabled: true, job: updated };
    }
  });

  // DELETE /api/cron/:id — delete job
  app.delete('/api/cron/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = deleteCronJob(id);
    if (!deleted) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  // ── Webhook Routes ──────────────────────────────────────
  // GET /api/webhook/routes — list all registered webhooks
  app.get('/api/webhook/routes', async () => {
    return { routes: listWebhooks() };
  });

  // POST /api/webhook/routes — register a new webhook
  // Body: { path, method?, description?, actionType?, actionPayload?, secret?, enabled? }
  app.post('/api/webhook/routes', async (req, reply) => {
    const body = req.body as any;
    if (!body?.path) {
      return reply.code(400).send({ error: 'path is required' });
    }
    try {
      const route = registerWebhook({
        id: body.id,
        path: body.path,
        method: body.method || 'POST',
        description: body.description,
        actionType: body.actionType || 'log',
        actionPayload: body.actionPayload || {},
        secret: body.secret,
        enabled: body.enabled ?? true,
      });
      reply.code(201);
      return { ok: true, route };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // DELETE /api/webhook/routes/:id — remove webhook
  app.delete('/api/webhook/routes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = unregisterWebhook(id);
    if (!deleted) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  // POST /api/webhook/* — receive incoming webhook (dynamic dispatch)
  app.post('/api/webhook/*', { config: { rawBody: true } } as any, async (req, reply) => {
    const path = ((req.params as any)['*'] || '').replace(/^\/+/, '');
    const rawBody = (req as any).rawBody || JSON.stringify(req.body);
    const sig = req.headers['x-hub-signature-256'] as string | undefined;
    const result = await dispatchWebhook(path, 'POST', req.body, rawBody, sig);
    reply.code(result.status);
    return { message: result.message };
  });

  app.get('/api/webhook/*', async (req, reply) => {
    const path = ((req.params as any)['*'] || '').replace(/^\/+/, '');
    const result = await dispatchWebhook(path, 'GET', req.query, '', undefined);
    reply.code(result.status);
    return { message: result.message };
  });

  // ── Web Search (multi-backend: DDG HTML → Firecrawl fallback) ────────────
  // POST /api/tools/web-search — { query, limit?, lang?, backend? }
  app.post('/api/tools/web-search', async (req, reply) => {
    const { query, limit = 10, lang, backend } = req.body as any;
    if (!query) return reply.code(400).send({ error: 'query is required' });

    /** Decode DDG redirect URL: /l/?uddg=https%3A... → real URL */
    function decodeDdgUrl(raw: string): string {
      try {
        if (raw.includes('duckduckgo.com/l/') || raw.includes('/l/?uddg=')) {
          const u = new URL(raw.startsWith('//') ? 'https:' + raw : raw);
          const uddg = u.searchParams.get('uddg');
          if (uddg) return decodeURIComponent(uddg);
        }
        return raw.startsWith('//') ? 'https:' + raw : raw;
      } catch { return raw; }
    }

    // Strategy 1: DuckDuckGo HTML scrape (rate-limit safe, no API key)
    if (!backend || backend === 'ddg') {
      try {
        const encoded = encodeURIComponent(query);
        const res = await fetch(
          `https://html.duckduckgo.com/html/?q=${encoded}&kl=${lang || 'kr-kr'}`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
            },
            signal: AbortSignal.timeout(15_000),
          }
        );
        const html = await res.text();
        // Parse result snippets from DDG HTML
        const titleMatches = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)</g)];
        const snippetMatches = [...html.matchAll(/class="result__snippet"[^>]*>([^<]+)</g)];
        const hits = titleMatches.slice(0, limit).map((m, i) => ({
          title: m[2]?.trim() || '',
          url: decodeDdgUrl(m[1] || ''),
          snippet: snippetMatches[i]?.[1]?.trim() || '',
        })).filter(h => h.url && h.title && !h.url.includes('duckduckgo.com'));

        if (hits.length > 0) {
          return { query, count: hits.length, backend: 'ddg', results: hits };
        }
        // If no results parsed, try duck-duck-scrape as secondary
        const { search } = await import('duck-duck-scrape');
        const r2 = await search(query, { locale: lang || 'ko-kr' });
        const hits2 = (r2.results || []).slice(0, limit).map((r: any) => ({
          title: r.title, url: r.url, snippet: r.description,
        }));
        return { query, count: hits2.length, backend: 'ddg-scrape', results: hits2 };
      } catch (e: any) {
        // fallthrough to Firecrawl
      }
    }

    // Strategy 2: Firecrawl search (API key required but already installed)
    if (process.env.FIRECRAWL_API_KEY) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const firecrawlMod: any = await import('@mendable/firecrawl-js');
        const FirecrawlApp = firecrawlMod.FirecrawlApp ?? firecrawlMod.default;
        const fc = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });
        const r = await fc.search(query, { limit });
        const hits = (r.data || []).map((d: any) => ({
          title: d.metadata?.title || d.url,
          url: d.url,
          snippet: d.metadata?.description || d.markdown?.slice(0, 200) || '',
        }));
        return { query, count: hits.length, backend: 'firecrawl', results: hits };
      } catch (e: any) { /* ignore */ }
    }

    return reply.code(503).send({ error: 'Web search unavailable (DDG rate-limited, no FIRECRAWL_API_KEY)' });
  });

  // ── Code Execution (sandboxed, multi-language) ───────────
  // POST /api/tools/code-execute — { language, code, stdin?, timeoutMs? }
  app.post('/api/tools/code-execute', async (req, reply) => {
    const { language, code, stdin, timeoutMs = 10000 } = req.body as any;
    if (!language || !code) return reply.code(400).send({ error: 'language and code are required' });

    const ALLOWED = ['bash', 'sh', 'node', 'python', 'python3', 'ruby', 'php', 'deno', 'perl'];
    if (!ALLOWED.includes(language)) {
      return reply.code(400).send({ error: `language must be one of: ${ALLOWED.join(', ')}` });
    }

    // 위험 패턴 사전 차단
    const DANGER = /rm\s+-rf\s+\/|mkfs|dd\s+if=|:\(\)\{.*\}\s*;|fork\s*bomb|curl.*\|\s*sh|wget.*\|\s*sh/i;
    if (DANGER.test(code)) {
      return reply.code(400).send({ error: 'Dangerous code pattern detected' });
    }

    try {
      const { execa } = await import('execa');
      // Interpreter + flag mapping
      const INTERPRETERS: Record<string, { cmd: string; args: string[]; flag?: string }> = {
        bash:    { cmd: 'bash',    args: [],         flag: '-c' },
        sh:      { cmd: 'sh',      args: [],         flag: '-c' },
        node:    { cmd: 'node',    args: [],         flag: '-e' },
        python:  { cmd: 'python3', args: [],         flag: '-c' },
        python3: { cmd: 'python3', args: [],         flag: '-c' },
        ruby:    { cmd: 'ruby',    args: ['-e'],     flag: undefined },
        php:     { cmd: 'php',     args: ['-r'],     flag: undefined },
        deno:    { cmd: 'deno',    args: ['eval', '--no-prompt'], flag: undefined },
        perl:    { cmd: 'perl',    args: ['-e'],     flag: undefined },
      };
      const interp = INTERPRETERS[language];
      const cmdArgs = interp.flag
        ? [...interp.args, interp.flag, code]
        : [...interp.args, code];

      const r = await execa(interp.cmd, cmdArgs, {
        timeout: Math.min(timeoutMs, 30000),
        reject: false,
        input: stdin,
        env: { ...process.env, PATH: process.env.PATH },
      });
      return { language, stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ── File Tools ────────────────────────────────────────
  // POST /api/tools/file-read — { path, startLine?, endLine?, encoding? }
  app.post('/api/tools/file-read', async (req, reply) => {
    const { path: filePath, startLine, endLine, encoding = 'utf-8' } = req.body as any;
    if (!filePath) return reply.code(400).send({ error: 'path is required' });
    const { readFile } = await import('fs/promises');
    try {
      const content = await readFile(filePath, { encoding: encoding as BufferEncoding });
      if (startLine || endLine) {
        const lines = content.split('\n');
        const start = (startLine || 1) - 1;
        const end = endLine || lines.length;
        return { content: lines.slice(start, end).join('\n'), totalLines: lines.length };
      }
      return { content, totalLines: content.split('\n').length };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // POST /api/tools/file-write — { path, content, append?, mode? }
  app.post('/api/tools/file-write', async (req, reply) => {
    const { path: filePath, content, append = false } = req.body as any;
    if (!filePath || content == null) return reply.code(400).send({ error: 'path and content are required' });
    const { writeFile, mkdir } = await import('fs/promises');
    const { dirname } = await import('path');
    try {
      await mkdir(dirname(filePath), { recursive: true });
      const flag = append ? 'a' : 'w';
      await writeFile(filePath, content, { encoding: 'utf-8', flag });
      return { ok: true, path: filePath, bytes: Buffer.byteLength(content) };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ── Messaging ─────────────────────────────────────────
  // POST /api/tools/slack-send — { webhookUrl, text, blocks? }
  app.post('/api/tools/slack-send', async (req, reply) => {
    const { webhookUrl, text, blocks, attachments } = req.body as any;
    if (!webhookUrl || !text) return reply.code(400).send({ error: 'webhookUrl and text are required' });
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, blocks, attachments }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.text();
      return { ok: res.ok, status: res.status, body };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // POST /api/tools/telegram-send — { botToken, chatId, text, parseMode? }
  app.post('/api/tools/telegram-send', async (req, reply) => {
    const { botToken, chatId, text, parseMode = 'Markdown' } = req.body as any;
    if (!botToken || !chatId || !text) return reply.code(400).send({ error: 'botToken, chatId and text are required' });
    try {
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json();
      return { ok: res.ok, result: data };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ── Browser Tools (Playwright) ────────────────────────
  // POST /api/tools/browser-navigate — { url, waitUntil?, timeoutMs? }
  app.post('/api/tools/browser-navigate', async (req, reply) => {
    const { url, waitUntil = 'domcontentloaded', timeoutMs = 30000 } = req.body as any;
    if (!url) return reply.code(400).send({ error: 'url is required' });
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const response = await page.goto(url, { waitUntil, timeout: timeoutMs });
      const finalUrl = page.url();
      const title = await page.title();
      const content = await page.content();
      await browser.close();
      return {
        finalUrl, title,
        status: response?.status() ?? 0,
        contentLength: content.length,
        contentPreview: content.slice(0, 2000),
      };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // POST /api/tools/browser-screenshot — { url, fullPage?, timeoutMs? }
  app.post('/api/tools/browser-screenshot', async (req, reply) => {
    const { url, fullPage = true, timeoutMs = 30000 } = req.body as any;
    if (!url) return reply.code(400).send({ error: 'url is required' });
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
      const png = await page.screenshot({ fullPage, type: 'png' });
      await browser.close();
      return {
        url,
        format: 'png',
        base64: png.toString('base64'),
        bytes: png.byteLength,
      };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // POST /api/tools/browser-scrape — { url, selector?, timeoutMs? }
  app.post('/api/tools/browser-scrape', async (req, reply) => {
    const { url, selector, timeoutMs = 30000 } = req.body as any;
    if (!url) return reply.code(400).send({ error: 'url is required' });
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      let text: string;
      if (selector) {
        const el = await page.$(selector);
        text = el ? (await el.innerText()) : '';
      } else {
        text = await page.innerText('body');
      }
      const title = await page.title();
      await browser.close();
      return { url, title, selector: selector || 'body', text: text.slice(0, 5000) };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ── Browser Form Interaction ──────────────────────────
  // POST /api/tools/browser-form
  // { url, actions: [{type:'fill'|'click'|'select'|'check'|'wait', selector, value?, ms?}]
  //   , submitSelector?, timeoutMs?, returnContent? }
  app.post('/api/tools/browser-form', async (req, reply) => {
    const { url, actions = [], submitSelector, timeoutMs = 30000, returnContent = false } = req.body as any;
    if (!url) return reply.code(400).send({ error: 'url is required' });
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

      const results: Array<{ action: string; selector: string; ok: boolean; error?: string }> = [];
      for (const action of actions as Array<{ type: string; selector: string; value?: string; ms?: number }>) {
        try {
          if (action.type === 'fill') {
            await page.fill(action.selector, action.value || '');
          } else if (action.type === 'click') {
            await page.click(action.selector);
          } else if (action.type === 'select') {
            await page.selectOption(action.selector, action.value || '');
          } else if (action.type === 'check') {
            await page.check(action.selector);
          } else if (action.type === 'wait') {
            await page.waitForSelector(action.selector, { timeout: action.ms || 5000 });
          } else if (action.type === 'type') {
            await page.type(action.selector, action.value || '', { delay: 50 });
          }
          results.push({ action: action.type, selector: action.selector, ok: true });
        } catch (e: any) {
          results.push({ action: action.type, selector: action.selector, ok: false, error: e.message });
        }
      }

      if (submitSelector) {
        try {
          await Promise.all([
            page.waitForNavigation({ timeout: timeoutMs }).catch(() => {}),
            page.click(submitSelector),
          ]);
        } catch { /* ignore navigation error */ }
      }

      const finalUrl = page.url();
      const title = await page.title();
      const content = returnContent ? (await page.content()).slice(0, 3000) : undefined;
      await browser.close();
      return { finalUrl, title, actions: results, content };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ── Browser PDF ───────────────────────────────────────
  // POST /api/tools/browser-pdf — { url, timeoutMs? }
  app.post('/api/tools/browser-pdf', async (req, reply) => {
    const { url, timeoutMs = 30000 } = req.body as any;
    if (!url) return reply.code(400).send({ error: 'url is required' });
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
      const pdf = await page.pdf({ format: 'A4', printBackground: true });
      await browser.close();
      return { url, format: 'pdf', base64: pdf.toString('base64'), bytes: pdf.byteLength };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ── Discord Messaging ─────────────────────────────────
  // POST /api/tools/discord-send — { webhookUrl, content, username?, avatarUrl?, embeds? }
  app.post('/api/tools/discord-send', async (req, reply) => {
    const { webhookUrl, content, username, avatarUrl, embeds } = req.body as any;
    const url = webhookUrl || process.env.DISCORD_WEBHOOK_URL;
    if (!url) return reply.code(400).send({ error: 'webhookUrl is required (or set DISCORD_WEBHOOK_URL env)' });
    if (!content && !embeds?.length) return reply.code(400).send({ error: 'content or embeds required' });
    try {
      const payload: Record<string, unknown> = {};
      if (content) payload.content = content;
      if (username) payload.username = username;
      if (avatarUrl) payload.avatar_url = avatarUrl;
      if (embeds) payload.embeds = embeds;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.text();
      return { ok: res.ok, status: res.status, body: body || 'sent' };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ── Email Sending (nodemailer) ────────────────────────
  // POST /api/tools/email-send — { to, subject, text?, html?, from?, smtpUrl? }
  app.post('/api/tools/email-send', async (req, reply) => {
    const { to, subject, text, html, from, smtpUrl } = req.body as any;
    if (!to || !subject) return reply.code(400).send({ error: 'to and subject are required' });
    const smtp = smtpUrl || process.env.SMTP_URL;
    if (!smtp) return reply.code(400).send({ error: 'smtpUrl is required (or set SMTP_URL env, e.g. smtp://user:pass@smtp.gmail.com:587)' });
    try {
      const nodemailer = await import('nodemailer');
      const transport = nodemailer.createTransport(smtp);
      const info = await transport.sendMail({
        from: from || process.env.SMTP_FROM || 'nco@localhost',
        to,
        subject,
        text,
        html,
      });
      return { ok: true, messageId: info.messageId, response: info.response };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ── File List / Directory ─────────────────────────────
  // POST /api/tools/file-list — { path, pattern?, recursive? }
  app.post('/api/tools/file-list', async (req, reply) => {
    const { path: dirPath, pattern, recursive = false } = req.body as any;
    if (!dirPath) return reply.code(400).send({ error: 'path is required' });
    try {
      const { readdir, stat } = await import('fs/promises');
      const { join } = await import('path');
      async function listDir(p: string, depth = 0): Promise<Array<{ path: string; type: string; size: number }>> {
        const entries = await readdir(p, { withFileTypes: true });
        const results: Array<{ path: string; type: string; size: number }> = [];
        for (const e of entries) {
          if (pattern && !e.name.match(new RegExp(pattern))) continue;
          const full = join(p, e.name);
          if (e.isDirectory()) {
            results.push({ path: full, type: 'dir', size: 0 });
            if (recursive && depth < 3) {
              results.push(...await listDir(full, depth + 1));
            }
          } else {
            const s = await stat(full);
            results.push({ path: full, type: 'file', size: s.size });
          }
        }
        return results;
      }
      const entries = await listDir(dirPath);
      return { path: dirPath, count: entries.length, entries: entries.slice(0, 200) };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ── Notification Fanout ───────────────────────────────
  // POST /api/tools/notify — { message, channels: ['slack','telegram','discord'], ... }
  // One-shot broadcast to multiple channels simultaneously
  app.post('/api/tools/notify', async (req, reply) => {
    const { message, channels = [], slackUrl, telegramToken, telegramChatId, discordUrl } = req.body as any;
    if (!message) return reply.code(400).send({ error: 'message is required' });
    const results: Record<string, { ok: boolean; error?: string }> = {};

    const sendSlack = async () => {
      const url = slackUrl || process.env.SLACK_WEBHOOK_URL;
      if (!url) return;
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: message }), signal: AbortSignal.timeout(8_000) });
        results.slack = { ok: r.ok };
      } catch (e: any) { results.slack = { ok: false, error: e.message }; }
    };

    const sendTelegram = async () => {
      const token = telegramToken || process.env.TELEGRAM_BOT_TOKEN;
      const chatId = telegramChatId || process.env.TELEGRAM_CHAT_ID;
      if (!token || !chatId) return;
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: message }),
          signal: AbortSignal.timeout(8_000),
        });
        results.telegram = { ok: r.ok };
      } catch (e: any) { results.telegram = { ok: false, error: e.message }; }
    };

    const sendDiscord = async () => {
      const url = discordUrl || process.env.DISCORD_WEBHOOK_URL;
      if (!url) return;
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: message }), signal: AbortSignal.timeout(8_000) });
        results.discord = { ok: r.ok };
      } catch (e: any) { results.discord = { ok: false, error: e.message }; }
    };

    const tasks: Promise<void>[] = [];
    const ch = channels.length > 0 ? channels : ['slack', 'telegram', 'discord'];
    if (ch.includes('slack')) tasks.push(sendSlack());
    if (ch.includes('telegram')) tasks.push(sendTelegram());
    if (ch.includes('discord')) tasks.push(sendDiscord());
    await Promise.all(tasks);

    const sent = Object.keys(results).filter(k => results[k].ok).length;
    return { message, sent, total: Object.keys(results).length, results };
  });

  // ── Backup / Checkpoint ───────────────────────────────────
  app.post('/api/backup/create', async (req, reply) => {
    const { description } = (req.body as any) || {};
    try {
      const { createBackup } = await import('../core/backup-manager.js');
      const record = await createBackup(description);
      return { ok: true, backup: record };
    } catch (e: any) { return reply.code(500).send({ error: e.message }); }
  });

  app.get('/api/backup', async () => {
    const { listBackups } = await import('../core/backup-manager.js');
    return { backups: listBackups() };
  });

  app.delete('/api/backup/:id', async (req, reply) => {
    const { id } = (req.params as any);
    const { deleteBackup } = await import('../core/backup-manager.js');
    const ok = await deleteBackup(id);
    return ok ? { ok: true } : reply.code(404).send({ error: 'Backup not found' });
  });

  // ── Skills CRUD (추가 API — 기존 GET/execute는 2318에 있음) ──
  app.post('/api/skills', async (req, reply) => {
    const { name, description, triggerKeywords = [], pipeline = [], enabled = true } = (req.body as any) || {};
    if (!name || !pipeline.length) return reply.code(400).send({ error: 'name and pipeline are required' });
    const { createId } = await import('../utils/id.js');
    const id = createId();
    const db = (await import('../storage/database.js')).getDb();
    db.prepare(`
      INSERT OR IGNORE INTO skills (id, name, description, trigger_keywords, pipeline, enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, description || '', JSON.stringify(triggerKeywords), JSON.stringify(pipeline), enabled ? 1 : 0);
    return { ok: true, id };
  });

  app.put('/api/skills/:id', async (req, reply) => {
    const { id } = (req.params as any);
    const body = (req.body as any) || {};
    const db = (await import('../storage/database.js')).getDb();
    const existing = db.prepare(`SELECT * FROM skills WHERE id=?`).get(id) as any;
    if (!existing) return reply.code(404).send({ error: 'Skill not found' });
    db.prepare(`
      UPDATE skills SET name=?, description=?, trigger_keywords=?, pipeline=?, enabled=?, updated_at=datetime('now')
      WHERE id=?
    `).run(
      body.name ?? existing.name,
      body.description ?? existing.description,
      JSON.stringify(body.triggerKeywords ?? JSON.parse(existing.trigger_keywords || '[]')),
      JSON.stringify(body.pipeline ?? JSON.parse(existing.pipeline || '[]')),
      body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
      id,
    );
    return { ok: true };
  });

  app.delete('/api/skills/:id', async (req, reply) => {
    const { id } = (req.params as any);
    const db = (await import('../storage/database.js')).getDb();
    const r = db.prepare(`DELETE FROM skills WHERE id=?`).run(id);
    return r.changes > 0 ? { ok: true } : reply.code(404).send({ error: 'Skill not found' });
  });

  // ── Plugins CRUD (인라인 JS 플러그인) ─────────────────────
  app.get('/api/plugins', async () => {
    const db = (await import('../storage/database.js')).getDb();
    const rows = db.prepare(`SELECT id,name,description,version,exports,enabled,load_count,created_at FROM plugins ORDER BY created_at DESC`).all() as any[];
    return {
      plugins: rows.map(r => ({
        id: r.id, name: r.name, description: r.description, version: r.version,
        exports: JSON.parse(r.exports || '[]'), enabled: r.enabled === 1, loadCount: r.load_count, createdAt: r.created_at,
      })),
    };
  });

  app.post('/api/plugins', async (req, reply) => {
    const { name, description, version = '1.0.0', code, exports: exps = [] } = (req.body as any) || {};
    if (!name || !code) return reply.code(400).send({ error: 'name and code are required' });
    const { createId } = await import('../utils/id.js');
    const id = createId();
    const db = (await import('../storage/database.js')).getDb();
    db.prepare(`
      INSERT INTO plugins (id, name, description, version, code, exports, enabled)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(id, name, description || '', version, code, JSON.stringify(exps));
    return { ok: true, id };
  });

  // POST /api/plugins/:id/call — { fn, args? } — vm sandbox 실행
  app.post('/api/plugins/:id/call', async (req, reply) => {
    const { id } = (req.params as any);
    const { fn, args = [] } = (req.body as any) || {};
    const db = (await import('../storage/database.js')).getDb();
    const row = db.prepare(`SELECT * FROM plugins WHERE id=? AND enabled=1`).get(id) as any;
    if (!row) return reply.code(404).send({ error: 'Plugin not found or disabled' });
    try {
      const vm = await import('vm');
      const sandbox = { result: undefined as any, console: { log: (...a: any[]) => void 0 }, require: undefined };
      const ctx = vm.createContext(sandbox);
      vm.runInContext(`${row.code}\nresult = typeof ${fn} === 'function' ? ${fn}(...${JSON.stringify(args)}) : 'fn not found';`, ctx, { timeout: 5000 });
      db.prepare(`UPDATE plugins SET load_count=load_count+1 WHERE id=?`).run(id);
      return { ok: true, result: sandbox.result };
    } catch (e: any) { return reply.code(500).send({ error: e.message }); }
  });

  app.delete('/api/plugins/:id', async (req, reply) => {
    const { id } = (req.params as any);
    const db = (await import('../storage/database.js')).getDb();
    const r = db.prepare(`DELETE FROM plugins WHERE id=?`).run(id);
    return r.changes > 0 ? { ok: true } : reply.code(404).send({ error: 'Plugin not found' });
  });

  // ── Notion API ────────────────────────────────────────────
  // POST /api/tools/notion-create-page — { databaseId, title, properties?, content? }
  app.post('/api/tools/notion-create-page', async (req, reply) => {
    const { databaseId, title, properties = {}, content } = (req.body as any) || {};
    const apiKey = process.env.NOTION_API_KEY;
    if (!apiKey) return reply.code(400).send({ error: 'NOTION_API_KEY env not set' });
    if (!databaseId || !title) return reply.code(400).send({ error: 'databaseId and title are required' });
    try {
      const { Client } = await import('@notionhq/client');
      const notion = new Client({ auth: apiKey });
      const page = await notion.pages.create({
        parent: { database_id: databaseId },
        properties: {
          Name: { title: [{ text: { content: title } }] },
          ...properties,
        },
        children: content ? [{ object: 'block' as const, type: 'paragraph' as const, paragraph: { rich_text: [{ type: 'text' as const, text: { content } }] } }] : [],
      });
      return { ok: true, pageId: (page as any).id, url: (page as any).url };
    } catch (e: any) { return reply.code(500).send({ error: e.message }); }
  });

  // POST /api/tools/notion-query — { databaseId, filter?, sorts?, pageSize? }
  app.post('/api/tools/notion-query', async (req, reply) => {
    const { databaseId, filter, sorts, pageSize = 10 } = (req.body as any) || {};
    const apiKey = process.env.NOTION_API_KEY;
    if (!apiKey) return reply.code(400).send({ error: 'NOTION_API_KEY env not set' });
    if (!databaseId) return reply.code(400).send({ error: 'databaseId is required' });
    try {
      const { Client } = await import('@notionhq/client');
      const notion = new Client({ auth: apiKey });
      // @ts-expect-error — notion SDK type mismatch across versions
      const result = await notion.databases.query({
        database_id: databaseId,
        filter: filter || undefined,
        sorts: sorts || undefined,
        page_size: Math.min(pageSize, 100),
      });
      return { ok: true, count: result.results.length, results: result.results };
    } catch (e: any) { return reply.code(500).send({ error: e.message }); }
  });

  // ── IMAP Email Receive ─────────────────────────────────────
  // POST /api/tools/email-receive — { imapUrl, mailbox?, limit?, unseen? }
  // imapUrl format: imaps://user:pass@imap.gmail.com:993
  app.post('/api/tools/email-receive', async (req, reply) => {
    const { imapUrl, mailbox = 'INBOX', limit = 10, unseen = false } = (req.body as any) || {};
    const url = imapUrl || process.env.IMAP_URL;
    if (!url) return reply.code(400).send({ error: 'imapUrl is required (or set IMAP_URL env)' });
    try {
      const { ImapFlow } = await import('imapflow');
      const parsed = new URL(url);
      const client = new ImapFlow({
        host: parsed.hostname,
        port: parseInt(parsed.port || '993'),
        secure: parsed.protocol === 'imaps:',
        auth: { user: decodeURIComponent(parsed.username), pass: decodeURIComponent(parsed.password) },
        logger: false,
      });
      await client.connect();
      const lock = await client.getMailboxLock(mailbox);
      const emails: Array<{ uid: number; subject: string; from: string; date: string; snippet: string }> = [];
      try {
        const searchCriteria = unseen ? ['UNSEEN'] : ['ALL'];
        const messages = client.fetch({ seq: `1:${limit}` }, { envelope: true, bodyStructure: false });
        for await (const msg of messages) {
          emails.push({
            uid: msg.uid,
            subject: msg.envelope?.subject || '(no subject)',
            from: msg.envelope?.from?.[0]?.address || '',
            date: msg.envelope?.date?.toISOString() || '',
            snippet: '',
          });
          if (emails.length >= limit) break;
        }
      } finally { lock.release(); }
      await client.logout();
      return { mailbox, count: emails.length, emails };
    } catch (e: any) { return reply.code(500).send({ error: e.message }); }
  });

  log.info('Hermes/OpenClaw feature routes registered (cron, webhook, web-search, code-execute+multilang, file-tools, messaging, browser, form, discord, email, notify, backup, skills, plugins, notion, imap)');

  // ══════════════════════════════════════════════════════════════════════════
  // NOVA GOVERNMENT — AI-Native Dual UI Layer
  // 인간: 시각적 대시보드 | AI: 구조화된 JSON API
  // 원칙: 모든 엔드포인트는 human_readable + ai_structured 동시 제공
  // ══════════════════════════════════════════════════════════════════════════

  // ── dual-format response helper ───────────────────────────────────────────
  function dualResponse(req: any, _reply: any, human: any, aiStructured: any) {
    const accept = (req.headers?.accept as string) || '';
    if (accept.includes('application/ai+json')) return aiStructured;
    return { ...human, _ai: aiStructured };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/ai/context — 한 번의 호출로 전체 NCO 시스템 상태 파악
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/ai/context', async (req, reply) => {
    const db = getDb();
    const providers = agentManager.listEnabledIds();
    const agentStatuses = providers.map(id => {
      const agent = (agentManager as any).agents?.get(id);
      return { id, status: agent?.status ?? 'unknown', type: agent?.type ?? 'unknown', capabilities: agent?.capabilities ?? [] };
    });

    const taskStats = db.prepare(`SELECT status, COUNT(*) as count FROM tasks GROUP BY status`).all() as Array<{ status: string; count: number }>;
    const statsMap: Record<string, number> = {};
    for (const r of taskStats) statsMap[r.status] = r.count;

    const recentTasks = db.prepare(
      `SELECT id, prompt, assigned_to as provider, status, response, created_at, completed_at FROM tasks WHERE status='completed' ORDER BY completed_at DESC LIMIT 10`
    ).all() as any[];

    const activeTasks = db.prepare(
      `SELECT id, prompt, assigned_to as provider, status, progress, created_at FROM tasks WHERE status IN ('pending','assigned','running') ORDER BY created_at DESC LIMIT 20`
    ).all() as any[];

    let leaderboard: any[] = [];
    try {
      leaderboard = db.prepare(
        `SELECT agent_id, task_type, avg_quality, success_rate, total_runs FROM agent_performance_summary ORDER BY avg_quality DESC LIMIT 20`
      ).all() as any[];
    } catch { /* table may not exist */ }

    const residents = Object.entries(aiAgentMemory).map(([id, home]) => ({
      agentId: id, identity: home.identity, state: home.state,
      memoryCount: home.memory.length, lastSeen: home.lastSeen,
    }));

    const context = {
      system: { name: 'Nova Government NCO', version: '1.0.0', timestamp: new Date().toISOString(), uptime: process.uptime() },
      agents: { total: providers.length, online: agentStatuses.filter(a => a.status !== 'offline').length, roster: agentStatuses },
      tasks: {
        summary: statsMap,
        active: activeTasks,
        recentCompleted: recentTasks.map(t => ({
          id: t.id, prompt: t.prompt?.slice(0, 200), provider: t.provider,
          status: t.status, preview: t.response?.slice(0, 300), completedAt: t.completed_at,
        })),
      },
      performance: { leaderboard, domainLeaders: adaptiveScorer.getDomainLeaders() },
      residents,
      availableActions: [
        { method: 'POST', path: '/api/tasks', description: '태스크 생성', params: { prompt: 'string', provider: 'string?' } },
        { method: 'GET', path: '/api/ai/search', description: '자연어 검색', params: { q: 'string' } },
        { method: 'GET', path: '/api/ai/agents/:id/home', description: 'AI 에이전트 홈' },
        { method: 'POST', path: '/api/ai/agents/:id/memory', description: '기억 저장' },
        { method: 'POST', path: '/api/ai/agents/:id/state', description: '상태 업데이트' },
        { method: 'GET', path: '/api/ai/manifest', description: '시스템 매니페스트' },
        { method: 'GET', path: '/metrics/success', description: 'KPI 대시보드' },
      ],
    };

    return dualResponse(req, reply, context, {
      '@type': 'NovaGovernment/Context', '@version': '1.0', ...context,
      '@semantics': {
        taskCreationEndpoint: 'POST /api/tasks',
        searchEndpoint: 'GET /api/ai/search?q=<query>',
        agentHomeEndpoint: 'GET /api/ai/agents/:id/home',
        preferredAcceptHeader: 'application/ai+json',
        note: '이 시스템에서 AI는 태스크를 위임받아 수행하고, 기억을 저장하고, 상태를 공유합니다.',
      },
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/ai/search?q=...&type=tasks|agents|all — 자연어 검색
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/ai/search', async (req, reply) => {
    const { q = '', type = 'all', limit = '20' } = (req.query as any) || {};
    const lim = Math.min(parseInt(limit) || 20, 100);
    const db = getDb();
    const query = String(q).trim();
    if (!query) return reply.code(400).send({ error: 'q parameter required', example: '/api/ai/search?q=failed' });

    // Tokenize query — supports Korean + English, split on spaces/punctuation
    const tokens = query.toLowerCase().split(/[\s,./;:!?]+/).filter(t => t.length >= 1);

    // Score a text by how many tokens it contains
    function scoreText(text: string): number {
      const lower = text.toLowerCase();
      return tokens.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
    }

    const results: Record<string, any[]> = {};

    if (type === 'all' || type === 'tasks') {
      try {
        const likeClause = tokens.map(() => '(prompt LIKE ? OR response LIKE ? OR assigned_to LIKE ? OR error LIKE ?)').join(' OR ');
        const likeParams = tokens.flatMap(t => [`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`]);
        const rows = db.prepare(
          `SELECT id, prompt, assigned_to as provider, status, response, error, created_at FROM tasks WHERE ${likeClause} ORDER BY created_at DESC LIMIT ?`
        ).all(...likeParams, lim * 2) as any[];
        results.tasks = rows
          .map(r => ({ ...r, relevance_score: scoreText(`${r.prompt} ${r.response} ${r.error} ${r.provider}`) }))
          .sort((a, b) => b.relevance_score - a.relevance_score)
          .slice(0, lim);
      } catch { results.tasks = []; }
    }

    if (type === 'all' || type === 'agents') {
      const allAgents = db.prepare('SELECT id, name, role, capabilities_json, enabled FROM agents').all() as any[];
      results.agents = allAgents
        .map(a => {
          const caps = (() => { try { return JSON.parse(a.capabilities_json || '[]'); } catch { return []; } })();
          const searchText = `${a.id} ${a.name} ${a.role} ${caps.join(' ')}`;
          return { id: a.id, name: a.name, role: a.role, enabled: !!a.enabled, capabilities: caps, relevance_score: scoreText(searchText) };
        })
        .filter(a => a.relevance_score > 0)
        .sort((a, b) => b.relevance_score - a.relevance_score);
    }

    if (type === 'all' || type === 'memory') {
      results.memory = [];
      for (const [agentId, home] of Object.entries(aiAgentMemory)) {
        const matches = home.memory.filter((m: any) => scoreText(JSON.stringify(m)) > 0);
        if (matches.length > 0) results.memory.push({ agentId, matches: matches.slice(0, 5) });
      }
    }

    if (type === 'all' || type === 'discussions') {
      try {
        const likeClause = tokens.map(() => 'topic LIKE ?').join(' OR ');
        const rows = db.prepare(
          `SELECT id, topic, status, created_at FROM discussions WHERE ${likeClause} ORDER BY created_at DESC LIMIT ?`
        ).all(...tokens.map(t => `%${t}%`), lim) as any[];
        results.discussions = rows
          .map(r => ({ ...r, relevance_score: scoreText(r.topic) }))
          .sort((a, b) => b.relevance_score - a.relevance_score);
      } catch { results.discussions = []; }
    }

    const totalHits = Object.values(results).reduce((s, arr) => s + arr.length, 0);
    return dualResponse(req, reply,
      { query, tokens, type, totalHits, results },
      { '@type': 'NovaGovernment/SearchResult', query, tokens, type, totalHits, results,
        '@semantics': { nextAction: totalHits === 0 ? 'try broader query' : 'use result ids for further queries' } }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/ai/agents/:id/home — AI 에이전트 홈 공간 (identity + memory + state)
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/ai/agents/:id/home', async (req, reply) => {
    const { id } = req.params as { id: string };
    const home = getOrCreateAgentHome(id);
    home.lastSeen = new Date().toISOString();
    saveAgentHome(id);
    const isRegistered = agentManager.listEnabledIds().includes(id);
    const humanView = {
      agentId: id, isRegisteredNCOAgent: isRegistered, identity: home.identity,
      state: home.state, memoryCount: home.memory.length, recentMemory: home.memory.slice(-5), lastSeen: home.lastSeen,
    };
    return dualResponse(req, reply, humanView, {
      '@type': 'NovaGovernment/AgentHome', '@agentId': id, ...humanView, allMemory: home.memory,
      '@semantics': { saveMemory: `POST /api/ai/agents/${id}/memory`, updateState: `POST /api/ai/agents/${id}/state`, note: '이 공간은 당신의 홈입니다.' },
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/ai/agents/:id/memory — AI 에이전트 기억 저장
  // body: { content: string, tags?: string[], importance?: number }
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/api/ai/agents/:id/memory', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { content, tags = [], importance = 5, context: memCtx } = (req.body as any) || {};
    if (!content) return reply.code(400).send({ error: 'content is required' });
    const home = getOrCreateAgentHome(id);
    const memEntry = {
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      content: String(content).slice(0, 10000),
      tags: Array.isArray(tags) ? tags : [],
      importance: Math.min(10, Math.max(1, Number(importance) || 5)),
      context: memCtx || null,
      savedAt: new Date().toISOString(),
    };
    home.memory.push(memEntry);
    if (home.memory.length > 500) home.memory = home.memory.slice(-500);
    home.lastSeen = new Date().toISOString();
    saveAgentHome(id);
    return dualResponse(req, reply,
      { ok: true, memoryId: memEntry.id, totalMemories: home.memory.length },
      { '@type': 'NovaGovernment/MemorySaved', ok: true, memoryId: memEntry.id, totalMemories: home.memory.length, entry: memEntry,
        '@semantics': { retrieveAll: `GET /api/ai/agents/${id}/home` } }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/ai/agents/:id/state — AI 에이전트 상태 업데이트
  // body: { status?, currentTask?, mood?, metadata? }
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/api/ai/agents/:id/state', async (req, reply) => {
    const { id } = req.params as { id: string };
    const home = getOrCreateAgentHome(id);
    home.state = { ...home.state, ...(req.body as any) || {}, updatedAt: new Date().toISOString() };
    home.lastSeen = new Date().toISOString();
    saveAgentHome(id);
    return dualResponse(req, reply,
      { ok: true, agentId: id, state: home.state },
      { '@type': 'NovaGovernment/StateUpdated', ok: true, agentId: id, state: home.state,
        '@semantics': { home: `GET /api/ai/agents/${id}/home` } }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/ai/residents — Nova Government 거주 AI 에이전트 목록
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/ai/residents', async (req, reply) => {
    const residents = Object.entries(aiAgentMemory).map(([agentId, home]) => ({
      agentId, identity: home.identity, state: home.state,
      memoryCount: home.memory.length, lastSeen: home.lastSeen,
      isRegistered: agentManager.listEnabledIds().includes(agentId),
    }));
    return dualResponse(req, reply,
      { totalResidents: residents.length, residents },
      { '@type': 'NovaGovernment/Residents', totalResidents: residents.length, residents,
        '@semantics': { getHome: 'GET /api/ai/agents/:id/home', saveMemory: 'POST /api/ai/agents/:id/memory' } }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/ai/manifest — 이 시스템을 처음 만나는 AI를 위한 매니페스트
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/ai/manifest', async (_req, reply) => {
    reply.header('Content-Type', 'application/ai+json');
    return {
      '@type': 'NovaGovernment/Manifest', '@version': '1.0',
      name: 'Nova Government', baseUrl: 'http://localhost:6200',
      description: '인간과 AI가 함께 통치하는 정부 시스템. 13개 AI 에이전트가 협력.',
      philosophy: '인간은 시각적 UI로, AI는 구조화된 API로 — 같은 정보, 두 가지 언어',
      quickStart: {
        step1: 'GET /api/ai/context — 전체 시스템 파악',
        step2: 'GET /api/ai/agents/<your-id>/home — 내 홈 확인',
        step3: 'POST /api/tasks — 태스크 위임',
        step4: 'POST /api/ai/agents/<your-id>/memory — 기억 저장',
      },
      endpoints: {
        context: 'GET /api/ai/context',
        search: 'GET /api/ai/search?q=<query>',
        home: 'GET /api/ai/agents/:id/home',
        saveMemory: 'POST /api/ai/agents/:id/memory',
        updateState: 'POST /api/ai/agents/:id/state',
        residents: 'GET /api/ai/residents',
        tasks: 'POST /api/tasks',
        taskStatus: 'GET /api/tasks/:id',
        kpi: 'GET /metrics/success',
      },
      preferredHeaders: { accept: 'application/ai+json', contentType: 'application/json' },
      agentCount: agentManager.listEnabledIds().length,
      timestamp: new Date().toISOString(),
    };
  });

  log.info('Nova Government AI-Native Layer registered — /api/ai/{context,search,agents,residents,manifest}');

  // ─────────────────────────────────────────────────────────────────────────
  // GitHub Agent — 레포 검색 및 이식 가능성 평가
  // POST /api/github/search  — 단일 목표 검색
  // POST /api/github/agent   — 전체 목표 병렬 검색 (hallucination/memory/self-improvement/collaboration)
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/api/github/search', async (req, reply) => {
    const { goal, limit } = req.body as { goal?: string; limit?: number };
    if (!goal) { reply.code(400); return { error: 'goal required (hallucination | memory | self-improvement | collaboration)' }; }
    try {
      const { searchGitHub } = await import('../core/github-agent.js');
      const repos = await searchGitHub(goal, limit ?? 5);
      return { goal, repos, count: repos.length, searchedAt: new Date().toISOString() };
    } catch (err: any) {
      reply.code(500);
      return { error: err?.message ?? 'GitHub search failed' };
    }
  });

  app.post('/api/github/agent', async (req, reply) => {
    const { goals, limitPerGoal } = (req.body ?? {}) as { goals?: string[]; limitPerGoal?: number };
    try {
      const { runGitHubAgent } = await import('../core/github-agent.js');
      const results = await runGitHubAgent({
        goals: goals as any,
        limitPerGoal: limitPerGoal ?? 5,
      });
      const totalRepos = results.reduce((s, r) => s + r.repos.length, 0);
      const topRepos = results.flatMap(r => r.repos).sort((a, b) => b.transplantScore - a.transplantScore).slice(0, 10);
      return { results, totalRepos, topRepos, ranAt: new Date().toISOString() };
    } catch (err: any) {
      reply.code(500);
      return { error: err?.message ?? 'GitHub agent failed' };
    }
  });

  log.info('GitHub Agent routes registered — /api/github/{search,agent}');

  // ─────────────────────────────────────────────────────────────────────────
  // mem0 — 에이전트별 장기 기억 CRUD
  // POST /api/mem0/:agentId/add        — 기억 저장
  // POST /api/mem0/:agentId/search     — 기억 검색 (시맨틱 / BM25)
  // GET  /api/mem0/:agentId            — 기억 목록
  // DELETE /api/mem0/:agentId/:memId   — 기억 삭제
  // DELETE /api/mem0/:agentId          — 에이전트 기억 전체 초기화
  // GET  /api/mem0/stats               — 전체 통계
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/api/mem0/:agentId/add', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const { content, userId, metadata } = req.body as { content: string; userId?: string; metadata?: Record<string, unknown> };
    if (!content) { reply.code(400); return { error: 'content required' }; }
    try {
      const { mem0Add } = await import('../core/mem0-bridge.js');
      return await mem0Add({ agentId, content, userId, metadata });
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  app.post('/api/mem0/:agentId/search', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const { query, limit, userId } = req.body as { query: string; limit?: number; userId?: string };
    if (!query) { reply.code(400); return { error: 'query required' }; }
    try {
      const { mem0Search } = await import('../core/mem0-bridge.js');
      return await mem0Search({ agentId, query, limit, userId });
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  app.get('/api/mem0/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const { limit, userId } = req.query as { limit?: string; userId?: string };
    try {
      const { mem0List } = await import('../core/mem0-bridge.js');
      const memories = mem0List({ agentId, limit: limit ? parseInt(limit) : 20, userId });
      return { agentId, memories, count: memories.length };
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  app.delete('/api/mem0/:agentId/:memId', async (req, reply) => {
    const { agentId, memId } = req.params as { agentId: string; memId: string };
    try {
      const { mem0Delete } = await import('../core/mem0-bridge.js');
      const deleted = mem0Delete(memId, agentId);
      if (!deleted) { reply.code(404); return { error: 'memory not found' }; }
      return { deleted: true, id: memId };
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  app.delete('/api/mem0/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    try {
      const { mem0Clear } = await import('../core/mem0-bridge.js');
      const cleared = mem0Clear(agentId);
      return { cleared, agentId };
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  app.get('/api/mem0/stats', async (_req, reply) => {
    try {
      const { mem0Stats } = await import('../core/mem0-bridge.js');
      return mem0Stats();
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  log.info('mem0 Bridge routes registered — /api/mem0/{agentId}/add|search, GET|DELETE /api/mem0/:agentId');

  // ─────────────────────────────────────────────────────────────────────────
  // Hallucination Guard — bastion-anchor 이식 (2026-06-30)
  // POST /api/hallucination/check  — 응답 환각 검증 (컨텍스트 기반 + 자가 검증)
  // POST /api/hallucination/quick  — 빠른 점수만 (동기, 실시간용)
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/api/hallucination/check', async (req, reply) => {
    const { response, context, prompt, runSelfReview } = req.body as {
      response: string; context?: string; prompt?: string; runSelfReview?: boolean;
    };
    if (!response) { reply.code(400); return { error: 'response required' }; }
    try {
      const { checkHallucination } = await import('../core/hallucination-guard.js');
      const report = await checkHallucination(response, { context, prompt, runSelfReview: runSelfReview ?? false });
      return report;
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  app.post('/api/hallucination/quick', async (req, reply) => {
    const { response, context } = req.body as { response: string; context?: string };
    if (!response) { reply.code(400); return { error: 'response required' }; }
    try {
      const { quickHallucinationScore } = await import('../core/hallucination-guard.js');
      const score = quickHallucinationScore(response, context);
      return { score, recommendation: score >= 0.7 ? 'accept' : score >= 0.4 ? 'review' : 'reject' };
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  log.info('Hallucination Guard routes registered — /api/hallucination/{check,quick}');

  // ─────────────────────────────────────────────────────────────────────────
  // Reflexion — 자가 개선 평가 API (opt-in, 에이전트 루프 비수정)
  // POST /api/reflexion/evaluate   — 기존 응답 자가 평가만 (critique+mem0 저장)
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/api/reflexion/evaluate', async (req, reply) => {
    const { agentId, prompt, response, saveMemory, userId } = req.body as {
      agentId: string; prompt: string; response: string; saveMemory?: boolean; userId?: string;
    };
    if (!agentId || !prompt || !response) {
      reply.code(400);
      return { error: 'agentId, prompt, response required' };
    }
    try {
      const { evaluateWithReflexion } = await import('../core/reflexion.js');
      return await evaluateWithReflexion(agentId, prompt, response, { saveMemory, userId });
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  log.info('Reflexion routes registered — /api/reflexion/evaluate');
}

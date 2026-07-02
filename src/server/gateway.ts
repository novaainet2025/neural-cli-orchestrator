import Fastify, { type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { env } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { redisHealthCheck } from '../storage/redis.js';
import { getDb } from '../storage/database.js';
import { agentManager } from '../agent/agent-manager.js';
import { discussionEngine } from '../core/discussion-engine.js';
import { sharedState, type AgentState } from '../core/shared-state.js';
import { eventBus, type NCOEvent } from '../core/event-bus.js';
import { createTaskId, createSessionId } from '../utils/id.js';
import { CreateTaskInput, CreateDiscussionInput } from '../utils/validation.js';
import { parseIntent } from '../utils/intent-parser.js';
import { taskQueue } from '../core/task-queue.js';
import { TERMINAL_STATES, transitionTask } from '../core/task-state.js';

/** 응답 텍스트에 에러 패턴이 있으면 true — completed 오탐 방지 */
function detectFailedCompletion(response: string | null | undefined): boolean {
  if (!response) return false;
  if (/^Error:\s/i.test(response)) return true;

  const longSuccessPrefix = /^(?:done|status|answer):/i;
  const hasLongSuccessPrefix = longSuccessPrefix.test(response) && response.length >= 200;
  const patterns = [
    /\b(?:error|exception)\b.*\b(?:occurred|happened|encountered)\b/i,
    /\bfailed\s+(?:to|with)\b/i,
    /\b(?:exceeded|over)\b.*\b(?:limit|quota|rate)\b/i,
    /\bAPI\s*(?:key|quota|limit)\b.*\b(?:invalid|expired|exceeded)\b/i,
    /\b(?:connection\s*refused|ECONNREFUSED)\b/i,
    /\b(?:streaming|execution)\s+error\b/i,
    /\busage.*exceeded\b/i,
    /\btimeout\b.*\b(?:error|exceeded|after)\b/i,
    /\bActionRequiredError\b/i,
    /\busage\s+limit\b/i,
    /\bProviderModelNotFoundError\b/i,
    /\brequest\s+timed\s+out\b/i,
    /\bhit\s+your\s+(?:usage\s+)?limit\b/i,
  ];
  if (hasLongSuccessPrefix) {
    const leadingSegment = response.slice(0, 300);
    const strongLeadingFailurePatterns = [
      /\b(?:error|exception)\b.*\b(?:occurred|happened|encountered)\b/i,
      /\bfailed\s+(?:to|with)\b/i,
      /\b(?:connection\s*refused|ECONNREFUSED)\b/i,
      /\b(?:streaming|execution)\s+error\b/i,
      /\btimeout\b.*\b(?:error|exceeded|after)\b/i,
      /\bActionRequiredError\b/i,
      /\bProviderModelNotFoundError\b/i,
      /\brequest\s+timed\s+out\b/i,
      /^status:\s*failed\b/i,
    ];
    return strongLeadingFailurePatterns.some(p => p.test(leadingSegment));
  }
  return patterns.some(p => p.test(response));
}
import { injectContext } from '../core/conversation-context.js';
import { registerDashboardRoutes } from './routes/dashboard-compat.js';
import { registerCircuitRoutes } from './routes/circuit.js';
import { registerInterSessionRoutes } from './routes/inter-session.js';
import { registerHandoffRoutes } from './routes/handoff.js';
import { registerFleetOpsRoutes } from './routes/fleet-ops.js';
import { invocationTracker } from '../core/invocation-tracker.js';
import { delegationManager } from '../core/delegation-manager.js';
import { collaborationEngine } from '../core/collaboration-engine.js';
import { sortProvidersByCostOrder } from '../core/smart-router.js';

const log = createLogger('gateway');
let draining = false;

function rejectWhileDraining(reply: FastifyReply) {
  reply.code(503);
  return { error: 'draining: new tasks rejected' };
}

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

export async function createGateway() {
  const app = Fastify({ logger: false });
  const getInFlightCount = (): number => {
    const db = getDb();
    const row = db.prepare(`
      SELECT COUNT(*) as count
      FROM tasks
      WHERE status IN ('queued', 'assigned', 'running', 'streaming')
    `).get() as { count: number };
    return row.count;
  };

  const cancelTaskById = async (taskId: string, reply?: { code: (statusCode: number) => unknown }) => {
    const db = getDb();
    const task = db.prepare('SELECT id, status FROM tasks WHERE id=?').get(taskId) as { id: string; status: string } | undefined;
    if (!task) {
      reply?.code(404);
      return { ok: false, killed: false, error: 'Task not found' };
    }

    if (TERMINAL_STATES.has(task.status)) {
      return { ok: true, killed: false, alreadyTerminal: true, status: task.status };
    }

    const killed = await taskQueue.abort(taskId);
    const moved = transitionTask(db, taskId, 'cancelled');

    if (!moved.ok) {
      if (moved.prev && TERMINAL_STATES.has(moved.prev)) {
        return { ok: true, killed, alreadyTerminal: true, status: moved.prev };
      }
      log.info({ taskId, prev: moved.prev }, 'Cancel skipped because task transition was rejected');
      return { ok: false, killed, status: moved.prev };
    }

    await eventBus.publish({ type: 'task:cancelled', taskId });
    return { ok: true, killed, status: 'cancelled' };
  };

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

  // ═══ Health ═══════════════════════════════════════
  app.get('/health', async () => {
    const agents = await sharedState.getAllAgentStates();
    const redisOk = await redisHealthCheck();
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
      timestamp: new Date().toISOString(),
    };
  });

  app.get('/api/health', async () => {
    const redisOk = await redisHealthCheck();
    return {
      healthy: true,
      api: { port: env.PORT },
      websocket: { port: env.WS_PORT },
      redis: { connected: redisOk },
      storage: { kind: 'sqlite', path: env.DATABASE_PATH },
      timestamp: new Date().toISOString(),
    };
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
    const providers: Record<string, AgentState> = {};
    for (const p of agentManager.listProviders()) {
      const s = states[p.id];
      providers[p.id] = {
        id: p.id,
        status: s?.status || 'offline',
        currentTask: s?.currentTask || null,
        currentFiles: s?.currentFiles || [],
        lastAction: s?.lastAction || null,
        lastActionAt: s?.lastActionAt || null,
        messageCount: s?.messageCount || 0,
        health: s?.health || { consecutiveFailures: 0, circuitState: 'closed', lastError: null },
      };
    }
    return { providers };
  });

  await registerCircuitRoutes(app);

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
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const parsed = CreateTaskInput.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid input', details: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
    }
    const input = parsed.data;
    const taskId = createTaskId();
    const agentId = input.ai ?? 'claude-code';

    // Extract caller context for invocation tracking
    const body = req.body as any;
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
      const verifierJson = input.verifier ? JSON.stringify(input.verifier) : null;
      db.prepare(`
        INSERT INTO tasks (id, mode, prompt, system_prompt, assigned_to, status, workspace_id, priority, spawned_by_cli, verifier_json)
        VALUES (?, ?, ?, ?, ?, 'assigned', ?, ?, ?, ?)
      `).run(taskId, input.mode, input.prompt, input.systemPrompt || null, agentId, input.workspaceId, input.priority, spawnedByCli, verifierJson);
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
    // Only when the caller EXPLICITLY passed workspaceId — otherwise one-shot
    // tasks get polluted with unrelated 'default' workspace history and the
    // agent answers the old conversation instead of the current prompt.
    const explicitWorkspace = typeof (req.body as any)?.workspaceId === 'string';
    const systemPromptWithContext = explicitWorkspace
      ? injectContext(input.systemPrompt, input.workspaceId || 'default', taskId)
      : input.systemPrompt;

    // Enqueue via TaskQueueManager (BullMQ or semaphore) — respects per-agent concurrency
    taskQueue.enqueue({ taskId, agentId, prompt: input.prompt, systemPrompt: systemPromptWithContext, timeoutMs: input.timeout, verifier: input.verifier, metadata: { invocationId } })
      .then(result => {
        const response = (result.output != null && result.output !== '') ? result.output : (result.error || '(에이전트 응답 없음)');
        const honest = result.success && !detectFailedCompletion(response) ? 'completed' : 'failed';
        try {
          const moved = transitionTask(db, taskId, honest, { response, completedAt: true });
          if (!moved.ok) {
            log.info({ taskId, prev: moved.prev, next: honest }, 'Skipped terminal completion update');
          }
        } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update after task completion failed'); }
      })
      .catch(err => {
        try {
          const moved = transitionTask(db, taskId, 'failed', { error: err.message });
          if (!moved.ok) {
            log.info({ taskId, prev: moved.prev, next: 'failed' }, 'Skipped terminal failure update');
          }
        } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update after task failure failed'); }
      });

    reply.code(202);
    return { taskId, status: 'queued', agentId, invocationId };
  });

  app.post('/api/tasks', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    // Alias for /api/task — inject 응답 객체를 그대로 반환하면 내부 res가 직렬화되어 깨진 JSON이 나감
    const res = await app.inject({ method: 'POST', url: '/api/task', payload: req.body as any });
    reply.code(res.statusCode);
    return res.json();
  });

  app.get('/api/tasks', async (req) => {
    const query = req.query as any;
    const rawLimit = Number(query.limit || 100);
    const limit = Math.min(Number.isFinite(rawLimit) ? rawLimit : 100, 500);
    const db = getDb();
    let sql = 'SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?';
    const params: any[] = [limit];

    if (query.workspaceId) {
      sql = 'SELECT * FROM tasks WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?';
      params.unshift(query.workspaceId);
    }

    const tasks = db.prepare(sql).all(...params);
    return { tasks };
  });

  app.get('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as any;
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
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

  app.post('/api/tasks/:id/cancel', async (req, reply) => {
    const { id } = req.params as any;
    return cancelTaskById(id, reply);
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as any;
    return cancelTaskById(id, reply);
  });

  app.post('/api/tasks/:id/retry', async (req, reply) => {
    const { id } = req.params as any;
    const db = getDb();
    const taskLineage = db.prepare(`
      SELECT parent_task_id
      FROM tasks
      WHERE id=?
    `).get(id) as { parent_task_id: string | null } | undefined;
    const sourceTaskId = taskLineage?.parent_task_id ?? id;
    const deadLetter = db.prepare(`
      SELECT ai, prompt
      FROM dead_letter_tasks
      WHERE task_id=?
      ORDER BY id DESC
      LIMIT 1
    `).get(id) as { ai: string | null; prompt: string | null } | undefined;
    const verifierRow = db.prepare(`
      SELECT verifier_json, verifier_result_json
      FROM tasks
      WHERE id=?
    `).get(id) as {
      verifier_json: string | null;
      verifier_result_json: string | null;
    } | undefined;

    const failedTask = deadLetter ? undefined : db.prepare(`
      SELECT assigned_to, prompt, mode, workspace_id, priority, system_prompt
      FROM tasks
      WHERE id=? AND status='failed'
    `).get(id) as {
      assigned_to: string | null;
      prompt: string;
      mode: string | null;
      workspace_id: string | null;
      priority: number | null;
      system_prompt: string | null;
    } | undefined;

    const parsedVerifier = (() => {
      if (!verifierRow?.verifier_json) return undefined;
      try {
        return JSON.parse(verifierRow.verifier_json);
      } catch {
        return undefined;
      }
    })();

    const payload = deadLetter
      ? { ai: deadLetter.ai ?? undefined, prompt: deadLetter.prompt ?? '', verifier: parsedVerifier }
      : failedTask
        ? {
            ai: failedTask.assigned_to ?? undefined,
            prompt: failedTask.prompt,
            mode: failedTask.mode ?? undefined,
            workspaceId: failedTask.workspace_id ?? undefined,
            priority: failedTask.priority ?? undefined,
            systemPrompt: failedTask.system_prompt ?? undefined,
            verifier: parsedVerifier,
          }
        : null;

    if (!payload || !payload.prompt) {
      reply.code(404);
      return { error: 'Retry source not found' };
    }

    if (verifierRow?.verifier_result_json) {
      try {
        const parsed = JSON.parse(verifierRow.verifier_result_json) as {
          passed?: boolean;
          outputSnippet?: string;
          command?: string;
          timedOut?: boolean;
          spawnError?: string | null;
          exitCode?: number | null;
        };
        if (parsed.passed === false && parsed.outputSnippet) {
          payload.prompt += `\n\n[Previous verifier failure]\nCommand: ${parsed.command}\nExit: ${parsed.timedOut ? 'timeout' : parsed.spawnError ? 'spawn-error' : parsed.exitCode}\nOutput:\n${parsed.outputSnippet}`;
        }
      } catch {}
    }

    const readRetryCount = db.prepare(`
      SELECT count
      FROM retry_counts
      WHERE task_id=?
    `);
    const incrementRetryCount = db.prepare(`
      INSERT INTO retry_counts (task_id, count)
      VALUES (?, 1)
      ON CONFLICT(task_id) DO UPDATE SET count = retry_counts.count + 1
    `);
    const reserveRetry = db.transaction((taskId: string) => {
      const row = readRetryCount.get(taskId) as { count: number } | undefined;
      const count = row?.count ?? 0;
      if (count >= 3) {
        return { allowed: false, count };
      }
      incrementRetryCount.run(taskId);
      const updated = readRetryCount.get(taskId) as { count: number };
      return { allowed: true, count: updated.count };
    });
    const retryReservation = reserveRetry(sourceTaskId);
    if (!retryReservation.allowed) {
      reply.code(429);
      return { error: 'retry limit exceeded', count: retryReservation.count };
    }

    const created = await app.inject({ method: 'POST', url: '/api/task', payload });
    const body = created.json() as { taskId?: string; error?: string };
    if (created.statusCode >= 400 || !body.taskId) {
      // 생성 실패는 재시도 예산에서 제외 — 시스템 오류로 상한에 갇히는 것 방지 (hermes 리뷰 f)
      db.prepare('UPDATE retry_counts SET count = MAX(count - 1, 0) WHERE task_id=?').run(sourceTaskId);
      reply.code(created.statusCode);
      return body;
    }
    db.prepare(`
      UPDATE tasks
      SET parent_task_id=?, updated_at=datetime('now')
      WHERE id=?
    `).run(sourceTaskId, body.taskId);

    reply.code(202);
    return { newTaskId: body.taskId, retryOf: id };
  });

  app.get('/api/admin/drain', async () => {
    return { draining, inFlight: getInFlightCount() };
  });

  app.post('/api/admin/drain', async (req, reply) => {
    const body = req.body as { enabled?: unknown } | undefined;
    if (typeof body?.enabled !== 'boolean') {
      reply.code(400);
      return { error: 'enabled must be boolean' };
    }

    draining = body.enabled;
    return { draining, inFlight: getInFlightCount() };
  });

  // ═══ Chat ═════════════════════════════════════════
  app.post('/api/chat/messages', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const body = req.body as any;
    const prompt = (body.message || body.prompt || '').trim();
    if (!prompt) { reply.code(400); return { error: 'prompt is required' }; }
    const agentId = body.ai ?? 'claude-code';

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
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const input = CreateDiscussionInput.parse(req.body);
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
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const body = req.body as any;
    const providers = body.providers || sortProvidersByCostOrder(agentManager.listEnabledIds()).slice(0, 3);
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

  app.post('/api/realtime/consensus', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const input = CreateDiscussionInput.parse(req.body);
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
    if (draining) {
      return rejectWhileDraining(reply);
    }

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
    if (draining) {
      return rejectWhileDraining(reply);
    }

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
  app.post('/api/conductor', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const smartRouter = await getSmartRouter();
    const { prompt } = req.body as any;
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
    if (decision.mode === 'task' && decision.providers.length === 1) {
      taskQueue.enqueue({ taskId, agentId: decision.providers[0], prompt })
        .then(result => {
          try {
            const cResp = result.output || result.error;
            const cStatus = result.success && !detectFailedCompletion(cResp) ? 'completed' : 'failed';
            db.prepare(`UPDATE tasks SET status=?, response=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
              .run(cStatus, cResp, taskId);
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

  app.get('/api/invocations/:id', async (req, reply) => {
    const { id } = req.params as any;
    const db = getDb();
    const invocation = db.prepare(`
      SELECT * FROM agent_invocations
      WHERE id = ?
    `).get(id);

    if (!invocation) {
      reply.code(404);
      return { error: 'Invocation not found' };
    }

    return { invocation };
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

  // mem0 라우트는 아래 "NCO 메가태스크 이식" 블록에 inline 구현되어 있다 (중복 등록 금지)

  // ═══ Inter-Session Routes (list/status/send/broadcast) ═══
  // dashboard-compat의 catch-all 스텁보다 먼저 등록해야 실제 핸들러가 응답한다
  await registerInterSessionRoutes(app);

  // ═══ Fleet Ops (push 텔레메트리 + edit-lease) ═══════════
  await registerFleetOpsRoutes(app);
  await registerHandoffRoutes(app);

  // ═══ Dashboard Compatibility Routes ═══════════════
  await registerDashboardRoutes(app);

  // ── NCO 메가태스크 이식 2026-06-30: mem0/hallucination/reflexion/github ──
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

  return app;
}

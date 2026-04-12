import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { redisHealthCheck } from '../storage/redis.js';
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
import { invocationTracker } from '../core/invocation-tracker.js';
import { delegationManager } from '../core/delegation-manager.js';

const log = createLogger('gateway');

export async function createGateway() {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });

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
    const handler = (event: NCOEvent) => { reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); };
    eventBus.on('*', handler);
    request.raw.on('close', () => { eventBus.off('*', handler); });
    await new Promise(() => {}); // keep alive
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
    const agentId = input.ai || 'claude-code';

    // Extract caller context for invocation tracking
    const body = req.body as any;
    const callerSessionId = body.callerSessionId
      || (req.headers['x-nco-session-id'] as string)
      || 'unknown';
    const callerAgentId = body.callerAgentId || 'unknown';

    // Save to DB
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, system_prompt, assigned_to, status, workspace_id, priority)
      VALUES (?, ?, ?, ?, ?, 'assigned', ?, ?)
    `).run(taskId, input.mode, input.prompt, input.systemPrompt || null, agentId, input.workspaceId, input.priority);

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
    taskQueue.enqueue({ taskId, agentId, prompt: input.prompt, systemPrompt: systemPromptWithContext, metadata: { invocationId } })
      .then(result => {
        db.prepare(`UPDATE tasks SET status=?, response=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
          .run(result.success ? 'completed' : 'failed', result.output || result.error, taskId);
      })
      .catch(err => {
        db.prepare(`UPDATE tasks SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`)
          .run(err.message, taskId);
      });

    reply.code(202);
    return { taskId, status: 'queued', agentId, invocationId };
  });

  app.post('/api/tasks', async (req, reply) => {
    // Alias for /api/task
    return app.inject({ method: 'POST', url: '/api/task', payload: req.body as any });
  });

  app.get('/api/tasks', async (req) => {
    const query = req.query as any;
    const limit = Math.min(Number(query.limit || 100), 500);
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

  app.delete('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as any;
    const db = getDb();

    // Abort via taskQueue (works for both BullMQ queued and semaphore active tasks)
    const killed = await taskQueue.abort(id);

    db.prepare("UPDATE tasks SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(id);
    await eventBus.publish({ type: 'task:cancelled', taskId: id });
    return { ok: true, killed };
  });

  // ═══ Chat ═════════════════════════════════════════
  app.post('/api/chat/messages', async (req, reply) => {
    const body = req.body as any;
    const prompt = body.message || body.prompt || '';
    const agentId = body.ai || 'claude-code';

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
    const result = parseIntent(body.query);
    return { intent: result };
  });

  // ═══ Discussions / Realtime ═══════════════════════
  app.post('/api/realtime/discussion', async (req, reply) => {
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
        db.prepare(`
          INSERT OR IGNORE INTO tasks (id, mode, prompt, assigned_to, status, response, completed_at, updated_at)
          VALUES (?, ?, ?, 'discussion-engine', 'completed', ?, datetime('now'), datetime('now'))
        `).run(taskId, input.mode, input.prompt, report.adoptedProposal);
        log.info({ sessionId, taskId, consensusRate: report.finalConsensusRate }, 'Discussion saved');
      })
      .catch(err => log.error({ err: err.message, sessionId }, 'Discussion failed'));

    return { sessionId, status: 'started', mode: input.mode };
  });

  app.post('/api/realtime/parallel', async (req, reply) => {
    const body = req.body as any;
    const providers = body.providers || agentManager.listEnabledIds().slice(0, 3);
    reply.code(202);

    const db = getDb();
    discussionEngine.executeParallel(body.prompt, providers)
      .then(responses => {
        // Save each parallel result as a completed task
        for (const [agentId, output] of Object.entries(responses)) {
          const taskId = createTaskId();
          db.prepare(`
            INSERT OR IGNORE INTO tasks (id, mode, prompt, assigned_to, status, response, completed_at, updated_at)
            VALUES (?, 'parallel', ?, ?, 'completed', ?, datetime('now'), datetime('now'))
          `).run(taskId, body.prompt, agentId, output as string);
        }
      })
      .catch(err => log.error({ err: err.message }, 'Parallel failed'));

    return { status: 'started', providers };
  });

  app.post('/api/realtime/consensus', async (req, reply) => {
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
        db.prepare(`
          INSERT OR IGNORE INTO tasks (id, mode, prompt, assigned_to, status, response, completed_at, updated_at)
          VALUES (?, 'consensus', ?, 'discussion-engine', 'completed', ?, datetime('now'), datetime('now'))
        `).run(taskId, input.prompt, report.adoptedProposal);
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
    const { cliMesh } = await import('../core/cli-mesh.js');
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
    const { cliMesh } = await import('../core/cli-mesh.js');
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
    const { cliMesh } = await import('../core/cli-mesh.js');
    const sessions = await cliMesh.getActiveSessions();
    return { sessions, count: sessions.length };
  });

  app.get('/api/mesh/summary', async () => {
    const { cliMesh } = await import('../core/cli-mesh.js');
    const summary = await cliMesh.getWorkSummary();
    return { summary };
  });

  app.post('/api/mesh/send', async (req) => {
    const { cliMesh } = await import('../core/cli-mesh.js');
    const { fromSessionId, fromAgent, toSessionId, content, type } = req.body as any;
    if (!fromSessionId || !content) return { error: 'fromSessionId and content required' };
    const delivered = await cliMesh.sendMessage(
      fromSessionId, fromAgent || 'unknown', toSessionId || '*', content, type || 'info',
    );
    // Broadcast new mesh message to dashboard
    await eventBus.publish({
      type: 'mesh:message',
      message: {
        from: fromSessionId,
        fromAgent: fromAgent || 'unknown',
        to: toSessionId || '*',
        content,
        messageType: type || 'info',
        createdAt: new Date().toISOString(),
      },
    } as any);
    return { delivered };
  });

  app.get('/api/mesh/messages/:sessionId', async (req) => {
    const { cliMesh } = await import('../core/cli-mesh.js');
    const { sessionId } = req.params as any;
    return { messages: cliMesh.getMessageHistory(sessionId) };
  });

  app.post('/api/mesh/complete', async (req) => {
    const { cliMesh } = await import('../core/cli-mesh.js');
    const { sessionId, completedWork } = req.body as any;
    if (!sessionId) return { error: 'sessionId required' };
    await cliMesh.complete(sessionId, completedWork);
    return { completed: true };
  });

  app.post('/api/mesh/disconnect', async (req) => {
    const { cliMesh } = await import('../core/cli-mesh.js');
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
    const { cliMesh } = await import('../core/cli-mesh.js');
    const { fromSessionId, fromAgent, content, type } = req.body as any;
    if (!fromSessionId || !content) return { error: 'fromSessionId and content required' };
    const delivered = await cliMesh.sendMessage(
      fromSessionId, fromAgent || 'unknown', '*', content, type || 'info',
    );
    await eventBus.publish({
      type: 'mesh:message',
      message: {
        from: fromSessionId,
        fromAgent: fromAgent || 'unknown',
        to: '*',
        content,
        messageType: type || 'info',
        createdAt: new Date().toISOString(),
      },
    } as any);
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
    const { cliMesh } = await import('../core/cli-mesh.js');
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
      agentStats,
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
    const { commander } = await import('../core/commander.js');
    const { prompt } = req.body as any;
    if (!prompt) return { error: 'prompt is required' };
    const result = await commander.executeCommand(prompt);
    return result;
  });

  app.get('/api/commander/layers', async () => {
    const { commander } = await import('../core/commander.js');
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
  app.post('/api/conductor', async (req) => {
    const { smartRouter } = await import('../core/smart-router.js');
    const { prompt } = req.body as any;
    if (!prompt) return { error: 'prompt is required' };

    const decision = await smartRouter.dispatch(prompt);

    // Delegate to the appropriate mode endpoint handler
    const db = getDb();
    const taskId = (await import('../utils/id.js')).createTaskId();

    // Record task
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, priority)
      VALUES (?, ?, ?, ?, 'assigned', 5)
    `).run(taskId, decision.mode, prompt, decision.providers[0] || null);

    // Execute via discussion engine for multi-agent modes, or taskQueue for single
    const sessionId = createSessionId();
    if (decision.mode === 'task' && decision.providers.length === 1) {
      taskQueue.enqueue({ taskId, agentId: decision.providers[0], prompt })
        .then(result => {
          db.prepare(`UPDATE tasks SET status=?, response=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
            .run(result.success ? 'completed' : 'failed', result.output || result.error, taskId);
        })
        .catch(err => {
          db.prepare(`UPDATE tasks SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`)
            .run(err.message, taskId);
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
          db.prepare(`UPDATE tasks SET status='completed', response=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
            .run(report.adoptedProposal, taskId);
        })
        .catch(err => {
          db.prepare(`UPDATE tasks SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`)
            .run(err.message, taskId);
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
    const { sessionManager } = await import('../agent/session-manager.js');
    const { prompt, provider, systemPrompt, autoApprove } = req.body as any;
    if (!prompt) return { error: 'prompt is required' };
    const agentId = provider || 'codex';
    const sessionId = await sessionManager.startSession(prompt, agentId, { systemPrompt, autoApprove });
    return { sessionId, status: 'running', agentId };
  });

  app.get('/api/agent/sessions', async () => {
    const { sessionManager } = await import('../agent/session-manager.js');
    const active = sessionManager.listSessions();
    const history = sessionManager.getSessionsFromDb(20);
    return { sessions: [...active, ...history.filter(h => !active.find(a => a.id === h.id))] };
  });

  app.get('/api/agent/:sessionId/status', async (req) => {
    const { sessionManager } = await import('../agent/session-manager.js');
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
    const { sessionManager } = await import('../agent/session-manager.js');
    const { sessionId } = req.params as any;
    const aborted = await sessionManager.abortSession(sessionId);
    return { aborted };
  });

  app.post('/api/agent/:sessionId/approve', async (req) => {
    const { sessionManager } = await import('../agent/session-manager.js');
    const { sessionId } = req.params as any;
    const approved = sessionManager.approveAction(sessionId);
    return { approved };
  });

  app.post('/api/agent/:sessionId/reject', async (req) => {
    const { sessionManager } = await import('../agent/session-manager.js');
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

  // ═══ Dashboard Compatibility Routes ═══════════════
  await registerDashboardRoutes(app);

  return app;
}

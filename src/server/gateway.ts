import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { redisHealthCheck } from '../storage/redis.js';
import { getDb } from '../storage/database.js';
import { agentManager } from '../agent/agent-manager.js';
import { discussionEngine } from '../core/discussion-engine.js';
import { sharedState } from '../core/shared-state.js';
import { eventBus } from '../core/event-bus.js';
import { createTaskId, createSessionId } from '../utils/id.js';
import { CreateTaskInput, CreateDiscussionInput } from '../utils/validation.js';

const log = createLogger('gateway');

export async function createGateway() {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });

  // ═══ Health ═══════════════════════════════════════
  app.get('/health', async () => {
    const agents = await sharedState.getAllAgentStates();
    const redisOk = await redisHealthCheck();
    return {
      status: 'ok',
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

  // ═══ AI Providers ═════════════════════════════════
  app.get('/api/ai-providers', async () => {
    return { providers: agentManager.listProviders() };
  });

  app.get('/api/ai-providers/enabled', async () => {
    return { providers: agentManager.listProviders().filter(p => p.enabled) };
  });

  app.get('/api/ai-providers/status', async () => {
    const states = await sharedState.getAllAgentStates();
    return { providers: states };
  });

  // ═══ Daemons ══════════════════════════════════════
  app.get('/api/daemons', async () => {
    const states = await sharedState.getAllAgentStates();
    const daemons = agentManager.listProviders().map(p => ({
      name: p.id,
      status: states[p.id]?.status || 'offline',
      running: states[p.id]?.status !== 'offline',
      available: states[p.id]?.health?.circuitState === 'closed',
      role: p.role,
      score: p.score,
      currentTask: states[p.id]?.currentTask || null,
    }));
    return { daemons };
  });

  // ═══ Tasks ════════════════════════════════════════
  app.post('/api/task', async (req, reply) => {
    const input = CreateTaskInput.parse(req.body);
    const taskId = createTaskId();
    const agentId = input.ai || 'claude-code';

    // Save to DB
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, system_prompt, assigned_to, status, workspace_id, priority)
      VALUES (?, ?, ?, ?, ?, 'assigned', ?, ?)
    `).run(taskId, input.mode, input.prompt, input.systemPrompt || null, agentId, input.workspaceId, input.priority);

    await eventBus.publish({ type: 'task:created', taskId, agentId, prompt: input.prompt });

    // Execute async (don't block response)
    agentManager.executeTask(agentId, input.prompt, { taskId, systemPrompt: input.systemPrompt })
      .then(result => {
        db.prepare(`UPDATE tasks SET status=?, response=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
          .run(result.success ? 'completed' : 'failed', result.output || result.error, taskId);
      })
      .catch(err => {
        db.prepare(`UPDATE tasks SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`)
          .run(err.message, taskId);
      });

    reply.code(202);
    return { taskId, status: 'assigned', agentId };
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
    db.prepare("UPDATE tasks SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(id);
    await eventBus.publish({ type: 'task:cancelled', taskId: id });
    return { ok: true };
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

  // ═══ Discussions / Realtime ═══════════════════════
  app.post('/api/realtime/discussion', async (req, reply) => {
    const input = CreateDiscussionInput.parse(req.body);
    reply.code(202);

    const sessionId = createSessionId();

    // Async — don't block
    discussionEngine.startDiscussion({
      topic: input.prompt,
      mode: input.mode as any,
      providers: input.providers,
      maxRounds: input.maxRounds,
      consensusThreshold: input.consensusThreshold,
    }).catch(err => log.error({ err: err.message }, 'Discussion failed'));

    return { sessionId, status: 'started', mode: input.mode };
  });

  app.post('/api/realtime/parallel', async (req, reply) => {
    const body = req.body as any;
    const providers = body.providers || agentManager.listEnabledIds().slice(0, 3);
    reply.code(202);

    discussionEngine.executeParallel(body.prompt, providers)
      .catch(err => log.error({ err: err.message }, 'Parallel failed'));

    return { status: 'started', providers };
  });

  app.post('/api/realtime/consensus', async (req, reply) => {
    const input = CreateDiscussionInput.parse(req.body);
    reply.code(202);

    discussionEngine.startDiscussion({
      topic: input.prompt,
      mode: 'consensus',
      providers: input.providers,
      consensusThreshold: input.consensusThreshold,
    }).catch(err => log.error({ err: err.message }, 'Consensus failed'));

    return { status: 'started', mode: 'consensus' };
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
  app.get('/api/queue/metrics', async () => {
    return { message: 'BullMQ metrics — Phase 5' };
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

  return app;
}

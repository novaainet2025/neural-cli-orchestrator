import { env } from './utils/config.js';
import { createLogger } from './utils/logger.js';
import { initTelemetry } from './core/telemetry.js';
import { getDb, runMigrations, closeDb } from './storage/database.js';
import { getRedis, closeRedis, redisHealthCheck } from './storage/redis.js';
import { eventBus } from './core/event-bus.js';
import { sharedState } from './core/shared-state.js';
import { syncEngine } from './core/sync-engine.js';
import { agentManager } from './agent/agent-manager.js';
import { sessionManager } from './agent/session-manager.js';
import { taskQueue } from './core/task-queue.js';
import { loadEnabledProviders } from './utils/config.js';
import { createGateway } from './server/gateway.js';
import { wsBridge } from './server/websocket.js';
import { getMonitorHTML } from './server/monitor.js';
import { getTopologyHTML } from './server/topology.js';

const log = createLogger('main');

async function boot(): Promise<void> {
  log.info('═══════════════════════════════════════');
  log.info('  NCO Backend — Neural CLI Orchestrator');
  log.info('═══════════════════════════════════════');

  // 0. Telemetry (noop if OTEL_EXPORTER_OTLP_ENDPOINT not set)
  await initTelemetry();

  // 1. SQLite + Migrations
  log.info('Initializing database...');
  const db = getDb();
  runMigrations();

  // 1b. Startup recovery: mark tasks stuck in "assigned" as failed
  //     These are tasks that were in-flight when the server was killed/restarted.
  const zombieResult = db.prepare(`
    UPDATE tasks
    SET status = 'failed',
        error  = 'timed_out: server restarted while task was in-flight',
        updated_at = datetime('now')
    WHERE status = 'assigned'
  `).run();
  if (zombieResult.changes > 0) {
    log.warn({ count: zombieResult.changes }, 'Startup recovery: marked in-flight tasks as failed');
  }

  // 2. Redis
  log.info('Connecting to Redis...');
  try {
    await getRedis();
    const healthy = await redisHealthCheck();
    log.info({ healthy }, 'Redis status');
  } catch (err) {
    log.warn('Redis unavailable — running in degraded mode (local-only)');
  }

  // 3. Event Bus
  log.info('Starting Event Bus...');
  await eventBus.init();

  // 4. Seed providers → DB + Redis
  log.info('Seeding providers...');
  await sharedState.seedProviders();

  // 5. Recovery sync (SQLite → Redis)
  await syncEngine.recoverySync();

  // 6. Start periodic sync (Redis → SQLite)
  syncEngine.start();

  // 7. Agent Manager
  log.info('Initializing Agent Manager...');
  await agentManager.init();

  // 7b. Task Queue (BullMQ per-agent, falls back to semaphore if Redis offline)
  log.info('Initializing Task Queue...');
  taskQueue.setExecutor(async (task, signal) => {
    const result = await agentManager.executeTask(task.agentId, task.prompt, {
      taskId: task.taskId,
      systemPrompt: task.systemPrompt,
      signal,
    });
    return { success: result.success, output: result.output, error: result.error };
  });
  await taskQueue.init(loadEnabledProviders());

  // 8. Fastify Gateway (HTTP :6200)
  log.info('Starting API Gateway...');
  const gateway = await createGateway();

  // Monitor page
  gateway.get('/monitor', async (req, reply) => {
    reply.type('text/html').send(getMonitorHTML(env.WS_PORT, env.PORT));
  });

  // Topology page
  gateway.get('/topology', async (req, reply) => {
    reply.type('text/html').send(getTopologyHTML(env.WS_PORT, env.PORT));
  });

  // 2026-07-02 사용자 승인: Tailscale 사설망 내 원격 NCO들의 fleet push 수신을 위해
  // 0.0.0.0 바인드 (HOST env로 재정의 가능 — 되돌리려면 HOST=127.0.0.1)
  await gateway.listen({ port: env.PORT, host: process.env.HOST ?? '0.0.0.0' });
  log.info({ port: env.PORT }, 'API Gateway listening');

  // 9. WebSocket Bridge (:6201)
  log.info('Starting WebSocket Bridge...');
  await wsBridge.start();

  // 10. Publish boot event
  await eventBus.publish({
    type: 'system:boot',
    service: 'nco-backend',
    version: '1.0.0',
    env: env.NODE_ENV,
  });

  log.info({ api: env.PORT, ws: env.WS_PORT }, 'NCO Backend fully operational');
  log.info('Monitor: http://localhost:' + env.PORT + '/monitor');
}

// ─── Graceful Shutdown ────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Shutting down...');
  wsBridge.stop();
  sessionManager.destroy();
  agentManager.destroy();
  await taskQueue.close();
  syncEngine.stop();
  eventBus.destroy();
  await closeRedis();
  closeDb();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Run ──────────────────────────────────────────────
boot().catch(err => {
  log.fatal({ err }, 'Boot failed');
  process.exit(1);
});

// Fix: MaxListeners memory leak — increase limit before any module loads
process.setMaxListeners(50);

import { env } from './utils/config.js';
import { createLogger } from './utils/logger.js';
import { getDb, runMigrations, closeDb } from './storage/database.js';
import { getRedis, closeRedis, redisHealthCheck } from './storage/redis.js';
import { eventBus } from './core/event-bus.js';
import { sharedState } from './core/shared-state.js';
import { syncEngine } from './core/sync-engine.js';
import { obsidianWatcher } from './core/obsidian-watcher.js';
import { supervisorEngine } from './core/supervisor-engine.js';
import { agentManager } from './agent/agent-manager.js';
import { sessionManager } from './agent/session-manager.js';
import { taskQueue } from './core/task-queue.js';
import { scheduleUbi } from './economy/ubiScheduler.js';
import { seedCivilServants, seedBuiltinPlugins } from './nova/governmentService.js';
import { scheduleAutonomousActions, scheduleMonthlySalary } from './nova/autonomousScheduler.js';
import { startThreatLevelScheduler } from './nova/threatLevelService.js';
import { scheduleGradeCron } from './identity/gradeService.js';
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

  // 1. SQLite + Migrations
  log.info('Initializing database...');
  const db = getDb();
  runMigrations();

  // 1b. Startup recovery: re-queue tasks stuck in "assigned" (in-flight during restart)
  //     Re-queue up to 5 recent tasks (< 10 min old); mark older ones as failed.
  const recentZombies = db.prepare(`
    SELECT id FROM tasks
    WHERE status = 'assigned'
      AND (julianday('now') - julianday(created_at)) * 86400 < 600
    ORDER BY created_at DESC LIMIT 5
  `).all() as { id: string }[];

  if (recentZombies.length > 0) {
    db.prepare(`
      UPDATE tasks SET status = 'pending', updated_at = datetime('now')
      WHERE id IN (${recentZombies.map(() => '?').join(',')})
    `).run(...recentZombies.map(r => r.id));
    log.warn({ count: recentZombies.length }, 'Startup recovery: re-queued recent in-flight tasks');
  }

  // Mark older stuck tasks as failed (> 10 min — likely abandoned)
  const zombieResult = db.prepare(`
    UPDATE tasks
    SET status = 'failed',
        error  = 'timed_out: server restarted while task was in-flight',
        updated_at = datetime('now')
    WHERE status = 'assigned'
  `).run();
  if (zombieResult.changes > 0) {
    log.warn({ count: zombieResult.changes }, 'Startup recovery: marked stale in-flight tasks as failed');
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

  // 7b. Obsidian Watcher & Supervisor Engine
  log.info('Starting Obsidian Watcher & Supervisor Engine...');
  await obsidianWatcher.start();
  await supervisorEngine.start();

  // 7c. Task Queue (BullMQ per-agent, falls back to semaphore if Redis offline)
  log.info('Initializing Task Queue...');
  taskQueue.setExecutor(async (task, signal) => {
    const result = await agentManager.executeTask(task.agentId, task.prompt, {
      taskId: task.taskId,
      systemPrompt: task.systemPrompt,
      signal,
      projectDir: task.metadata?.projectDir as string | undefined,
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

  await gateway.listen({ port: env.PORT, host: '127.0.0.1' });
  log.info({ port: env.PORT }, 'API Gateway listening');

  // 9. WebSocket Bridge (:6201)
  log.info('Starting WebSocket Bridge...');
  await wsBridge.start();

  // 10. Load persisted Cron Jobs (Hermes/OpenClaw transplant)
  try {
    const { loadCronJobs } = await import('./core/cron-scheduler.js');
    loadCronJobs();
    log.info('Cron Scheduler loaded');
  } catch (e: any) {
    log.warn({ err: e.message }, 'Cron Scheduler load skipped');
  }

  // 11. Publish boot event
  await eventBus.publish({
    type: 'system:boot',
    service: 'nco-backend',
    version: '1.0.0',
    env: env.NODE_ENV,
  });

  log.info({ api: env.PORT, ws: env.WS_PORT }, 'NCO Backend fully operational');
  log.info('Monitor: http://localhost:' + env.PORT + '/monitor');

  // Nova Government UBI 주간 자동 지급 스케줄러 (WELFARE-POLICY.md 13회차)
  scheduleUbi();

  // Nova Government — AI 공무원 + 플러그인 시드 + 자율 스케줄러
  seedCivilServants();
  seedBuiltinPlugins();
  scheduleAutonomousActions();
  startThreatLevelScheduler();
  scheduleGradeCron();
  scheduleMonthlySalary();
}

// ─── Graceful Shutdown ────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Shutting down...');
  wsBridge.stop();
  await obsidianWatcher.stop();
  await supervisorEngine.stop();
  sessionManager.destroy();
  agentManager.destroy();
  await taskQueue.close();
  syncEngine.stop();
  eventBus.destroy();
  await closeRedis();
  closeDb();
  // Give pino sync streams time to flush before exit
  // Prevents "sonic boom is not ready yet" crash from on-exit-leak-free
  await new Promise(r => setTimeout(r, 200));
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Run ──────────────────────────────────────────────
boot().catch(err => {
  log.fatal({ err }, 'Boot failed');
  process.exit(1);
});

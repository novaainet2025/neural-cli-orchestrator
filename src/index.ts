import { env } from './utils/config.js';
import { createLogger } from './utils/logger.js';
import { getDb, runMigrations, closeDb } from './storage/database.js';
import { getRedis, closeRedis, redisHealthCheck } from './storage/redis.js';
import { eventBus } from './core/event-bus.js';
import { sharedState } from './core/shared-state.js';
import { syncEngine } from './core/sync-engine.js';
import { agentManager } from './agent/agent-manager.js';
import { sessionManager } from './agent/session-manager.js';
import { createGateway } from './server/gateway.js';
import { wsBridge } from './server/websocket.js';
import { getMonitorHTML } from './server/monitor.js';

const log = createLogger('main');

async function boot(): Promise<void> {
  log.info('═══════════════════════════════════════');
  log.info('  NCO Backend — Neural CLI Orchestrator');
  log.info('═══════════════════════════════════════');

  // 1. SQLite + Migrations
  log.info('Initializing database...');
  getDb();
  runMigrations();

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

  // 8. Fastify Gateway (HTTP :6200)
  log.info('Starting API Gateway...');
  const gateway = await createGateway();

  // Monitor page
  gateway.get('/monitor', async (req, reply) => {
    reply.type('text/html').send(getMonitorHTML(env.WS_PORT, env.PORT));
  });

  await gateway.listen({ port: env.PORT, host: '127.0.0.1' });
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

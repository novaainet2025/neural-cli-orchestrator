import { createLogger } from './utils/logger.js';
import { loadEnabledProviders } from './utils/config.js';
import { getDb, runMigrations, closeDb } from './storage/database.js';
import { getRedis, closeRedis, redisHealthCheck } from './storage/redis.js';
import { eventBus } from './core/event-bus.js';
import { sharedState } from './core/shared-state.js';
import { syncEngine } from './core/sync-engine.js';
import { agentManager } from './agent/agent-manager.js';
import { taskQueue } from './core/task-queue.js';

const log = createLogger('worker');

async function boot(): Promise<void> {
  log.info('Starting NCO worker process');

  getDb();
  runMigrations();

  try {
    await getRedis();
    const healthy = await redisHealthCheck();
    log.info({ healthy }, 'Redis status');
  } catch (err) {
    log.warn({ err }, 'Redis unavailable; worker will run in degraded mode');
  }

  await eventBus.init();
  await sharedState.seedProviders();
  await syncEngine.recoverySync();
  syncEngine.start();

  await agentManager.init();

  taskQueue.setExecutor(async (task, signal) => {
    const result = await agentManager.executeTask(task.agentId, task.prompt, {
      taskId: task.taskId,
      systemPrompt: task.systemPrompt,
      model: task.model,
      signal,
      timeoutMs: task.timeoutMs,
      projectDir: task.metadata?.projectDir as string | undefined,
    });
    return { success: result.success, output: result.output, error: result.error, usage: result.usage };
  });
  await taskQueue.init(loadEnabledProviders());

  log.info('NCO worker ready');
}

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Shutting down worker');
  await taskQueue.close();
  syncEngine.stop();
  eventBus.destroy();
  agentManager.destroy();
  await closeRedis();
  closeDb();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

boot().catch(err => {
  log.fatal({ err }, 'Worker boot failed');
  process.exit(1);
});

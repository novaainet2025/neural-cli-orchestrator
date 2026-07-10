import { env } from './utils/config.js';
import { createLogger } from './utils/logger.js';
import { initTelemetry } from './core/telemetry.js';
import { getDb, runMigrations, closeDb } from './storage/database.js';
import { getRedis, closeRedis, redisHealthCheck } from './storage/redis.js';
import { eventBus } from './core/event-bus.js';
import { sharedState } from './core/shared-state.js';
import { syncEngine } from './core/sync-engine.js';
import { agentManager } from './agent/agent-manager.js';
import { circuitBreakerRegistry } from './security/circuit-breaker-registry.js';
import { sessionManager } from './agent/session-manager.js';
import { taskQueue } from './core/task-queue.js';
import { transitionTask } from './core/task-state.js';
import { loadCronJobs } from './core/cron-scheduler.js';
import { startWorkReportScheduler } from './core/work-report-scheduler.js';
import { loadEnabledProviders } from './utils/config.js';
import { createGateway } from './server/gateway.js';
import { wsBridge } from './server/websocket.js';
import { getMonitorHTML } from './server/monitor.js';
import { getTopologyHTML } from './server/topology.js';

const log = createLogger('main');
const SHUTDOWN_DRAIN_TIMEOUT_MS = 15_000;
const SHUTDOWN_POLL_INTERVAL_MS = 1_000;
const IN_FLIGHT_SHUTDOWN_STATUSES = ['assigned', 'in_progress', 'running', 'streaming'] as const;
const SHUTDOWN_ORPHAN_REASON = 'orphaned: graceful shutdown timeout';

let gateway: Awaited<ReturnType<typeof createGateway>> | null = null;
let shutdownPromise: Promise<void> | null = null;
let stopWorkReportScheduler: (() => void) | null = null;

/** 재큐잉 대상 orphan (부팅 후 taskQueue 준비되면 실제 enqueue) */
interface OrphanRequeue {
  taskId: string;
  agentId: string;
  prompt: string;
  model?: string;
  systemPrompt?: string;
  verifier?: { type: 'run'; command: string; timeoutMs?: number };
}

/** poison task(재시작을 유발한 태스크)의 무한 재큐잉을 막는 상한 */
const MAX_ORPHAN_REQUEUE = 2;

/**
 * B: 위임 대상 프로바이더가 가용하지 않으면(circuit open 등) 건강한 대체 프로바이더를 고른다.
 * 같은 role 우선, 없으면 아무 available. 하나도 없으면 null(→ 재큐잉 보류).
 * "리밋/다운 걸린 프로바이더에 위임하지 않는다"의 핵심 로직.
 */
function pickHealthyProvider(preferredId: string): string | null {
  const isUp = (id: string): boolean => {
    if (!agentManager.listEnabledIds().includes(id)) return false;
    const s = circuitBreakerRegistry.getAvailability(id).status;
    return s === 'available' || s === 'probe';
  };
  if (isUp(preferredId)) return preferredId;
  const preferredRole = agentManager.getProvider(preferredId)?.role;
  const healthy = agentManager.listEnabledIds().filter(isUp);
  if (healthy.length === 0) return null;
  const sameRole = healthy.find(id => agentManager.getProvider(id)?.role === preferredRole);
  return sameRole ?? healthy[0];
}

/**
 * 부팅 시 in-flight(queued/assigned/running/streaming) 태스크 복구.
 * 기존: 전부 failed+dead-letter로 종결(재시작마다 대량 실패 발생 — task 실패 근본원인 A).
 * 변경: 재큐잉 카운트 < MAX면 status='queued'로 되돌리고 재큐잉 목록에 담아 반환한다.
 *       (부팅 후 taskQueue.enqueue로 실제 재실행). agent 없음/poison(상한 초과)만 dead-letter.
 */
function recoverOrphanedTasks(): { requeued: OrphanRequeue[]; deadLettered: number } {
  const db = getDb();
  const orphans = db.prepare(`
    SELECT id, assigned_to, prompt, system_prompt, verifier_json, orphan_requeue_count
           , metadata_json
    FROM tasks
    WHERE status IN ('queued', 'assigned', 'running', 'streaming')
  `).all() as Array<{
    id: string; assigned_to: string | null; prompt: string;
    system_prompt: string | null; verifier_json: string | null; orphan_requeue_count: number;
    metadata_json: string | null;
  }>;

  const insertDeadLetter = db.prepare(`
    INSERT INTO dead_letter_tasks (task_id, ai, prompt, reason)
    VALUES (?, ?, ?, ?)
  `);
  const requeueStmt = db.prepare(`
    UPDATE tasks
    SET status='queued', orphan_requeue_count = orphan_requeue_count + 1,
        error=NULL, updated_at=datetime('now')
    WHERE id=?
  `);

  const requeued: OrphanRequeue[] = [];
  let deadLettered = 0;

  const handleOne = db.transaction((task: typeof orphans[number]): OrphanRequeue | null => {
    // agent 미지정 or poison(재큐잉 상한 초과) → dead-letter (기존 동작 유지)
    if (!task.assigned_to || (task.orphan_requeue_count ?? 0) >= MAX_ORPHAN_REQUEUE) {
      const reason = !task.assigned_to
        ? 'orphaned: server restart (no agent)'
        : `orphaned: server restart (poison — requeued ${task.orphan_requeue_count}x)`;
      const moved = transitionTask(db, task.id, 'failed', { error: reason, completedAt: true });
      if (moved.ok) insertDeadLetter.run(task.id, task.assigned_to, task.prompt, reason);
      deadLettered++;
      return null;
    }
    // 재큐잉: status를 queued로 되돌리고 카운트 증가. 실제 enqueue는 부팅 후.
    requeueStmt.run(task.id);
    let model: string | undefined;
    if (task.metadata_json) {
      try {
        const metadata = JSON.parse(task.metadata_json) as Record<string, unknown>;
        if (typeof metadata.model === 'string' && metadata.model.trim()) {
          model = metadata.model;
        }
      } catch {
        // ignore invalid metadata on orphan recovery
      }
    }
    return {
      taskId: task.id,
      agentId: task.assigned_to,
      prompt: task.prompt,
      model,
      systemPrompt: task.system_prompt ?? undefined,
      verifier: task.verifier_json ? JSON.parse(task.verifier_json) : undefined,
    };
  });

  for (const task of orphans) {
    const r = handleOne(task);
    if (r) requeued.push(r);
  }

  return { requeued, deadLettered };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getInFlightTasks() {
  const placeholders = IN_FLIGHT_SHUTDOWN_STATUSES.map(() => '?').join(', ');
  return getDb().prepare(`
    SELECT id, status, assigned_to
    FROM tasks
    WHERE status IN (${placeholders})
    ORDER BY created_at ASC
  `).all(...IN_FLIGHT_SHUTDOWN_STATUSES) as Array<{
    id: string;
    status: string;
    assigned_to: string | null;
  }>;
}

function markInFlightTasksAsOrphaned(tasks: Array<{ id: string }>): number {
  if (tasks.length === 0) return 0;
  const ids = tasks.map(task => task.id);
  const placeholders = ids.map(() => '?').join(', ');
  const statusPlaceholders = IN_FLIGHT_SHUTDOWN_STATUSES.map(() => '?').join(', ');
  const result = getDb().prepare(`
    UPDATE tasks
    SET status = CASE WHEN status = 'in_progress' THEN 'assigned' ELSE status END,
        error = ?,
        updated_at = datetime('now')
    WHERE id IN (${placeholders})
      AND status IN (${statusPlaceholders})
  `).run(
    SHUTDOWN_ORPHAN_REASON,
    ...ids,
    ...IN_FLIGHT_SHUTDOWN_STATUSES,
  );
  return result.changes;
}

async function waitForInFlightDrain(timeoutMs: number): Promise<{ drained: boolean; remaining: Array<{ id: string; status: string; assigned_to: string | null }> }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = getInFlightTasks();
    if (remaining.length === 0) {
      return { drained: true, remaining };
    }
    await sleep(Math.min(SHUTDOWN_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }

  const remaining = getInFlightTasks();
  return { drained: remaining.length === 0, remaining };
}

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
  const orphanRecovery = recoverOrphanedTasks();
  log.warn({ requeue: orphanRecovery.requeued.length, deadLetter: orphanRecovery.deadLettered }, 'Startup orphan recovery processed');

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
      model: task.model,
      signal,
      timeoutMs: task.timeoutMs,
      projectDir: task.metadata?.projectDir as string | undefined,
    });
    return { success: result.success, output: result.output, error: result.error, usage: result.usage };
  });
  await taskQueue.init(loadEnabledProviders());

  // 7b-2. orphan 재큐잉: 큐 준비 후 실제 enqueue (A: 재시작 in-flight 태스크를 fail 대신 재실행).
  //        B: 원래 프로바이더가 죽어있으면 건강한 대체로 재라우팅(죽은 곳 재큐잉 루프 방지).
  let reEnqueued = 0, reRouted = 0;
  for (const o of orphanRecovery.requeued) {
    const target = pickHealthyProvider(o.agentId);
    if (!target) {
      log.warn({ taskId: o.taskId, agent: o.agentId }, 'orphan re-enqueue보류 — 건강한 프로바이더 없음(다음 부팅 재시도)');
      continue;
    }
    if (target !== o.agentId) {
      try { getDb().prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(target, o.taskId); } catch { /* best-effort */ }
      log.info({ taskId: o.taskId, from: o.agentId, to: target }, 'orphan re-routed to healthy provider');
      reRouted++;
    }
    try {
      taskQueue.enqueue({ taskId: o.taskId, agentId: target, prompt: o.prompt, model: o.model, systemPrompt: o.systemPrompt, verifier: o.verifier });
      reEnqueued++;
    } catch (e) {
      log.warn({ taskId: o.taskId, err: (e as Error).message }, 'orphan re-enqueue failed');
    }
  }
  if (reEnqueued > 0) {
    log.info({ reEnqueued, reRouted }, 'Orphaned tasks re-enqueued for retry');
  }

  // 7c. Internal cron jobs
  loadCronJobs();

  // 8. Fastify Gateway (HTTP :6200)
  log.info('Starting API Gateway...');
  gateway = await createGateway();

  // Monitor page
  gateway.get('/monitor', async (req, reply) => {
    reply.type('text/html').send(getMonitorHTML(env.WS_PORT, env.PORT));
  });

  // Topology page
  gateway.get('/topology', async (req, reply) => {
    reply.type('text/html').send(getTopologyHTML(env.WS_PORT, env.PORT));
  });

  stopWorkReportScheduler = startWorkReportScheduler(gateway);

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
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
  log.info({ signal }, 'Shutting down...');
  if (gateway) {
    await gateway.close();
    log.info('API Gateway closed to new requests');
  }
  if (stopWorkReportScheduler) {
    stopWorkReportScheduler();
    stopWorkReportScheduler = null;
  }

  const drainResult = await waitForInFlightDrain(SHUTDOWN_DRAIN_TIMEOUT_MS);
  if (drainResult.drained) {
    log.info('In-flight task drain completed before shutdown timeout');
  } else {
    const orphaned = markInFlightTasksAsOrphaned(drainResult.remaining);
    log.warn({
      timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
      remaining: drainResult.remaining.length,
      orphaned,
      taskIds: drainResult.remaining.map(task => task.id),
    }, 'Shutdown drain timed out; remaining in-flight tasks marked orphaned');
  }

  await wsBridge.stop(signal);
  sessionManager.destroy();
  agentManager.destroy();
  await taskQueue.close();
  syncEngine.stop();
  eventBus.destroy();
  await closeRedis();
  closeDb();
  process.exit(0);
  })();
  return shutdownPromise;
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// ─── Run ──────────────────────────────────────────────
boot().catch(err => {
  log.fatal({ err }, 'Boot failed');
  process.exit(1);
});

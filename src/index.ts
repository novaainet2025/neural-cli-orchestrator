import { env } from './utils/config.js';
import { createLogger } from './utils/logger.js';
import { initTelemetry } from './core/telemetry.js';
import { getDb, runMigrations, closeDb } from './storage/database.js';
import { withSqliteBusyRetry } from './storage/sqlite-busy-retry.js';
import { getRedis, closeRedis, redisHealthCheck } from './storage/redis.js';
import { eventBus } from './core/event-bus.js';
import { sharedState } from './core/shared-state.js';
import { syncEngine } from './core/sync-engine.js';
import { agentManager } from './agent/agent-manager.js';
import { circuitBreakerRegistry } from './security/circuit-breaker-registry.js';
import { reconcileLegacyTeamCircuits } from './security/team-circuit-guard.js';
import { sessionManager } from './agent/session-manager.js';
import {
  claimTaskForStartupRecovery,
  duplicateExecutionResultFromError,
  isTaskQueueInstanceLive,
  isTaskExecutionJoinOutcome,
  persistRecoveredTaskResult,
  persistTaskQueueAttempt,
  reconcileStaleTaskQueueInstances,
  resolveTaskQueueRecoveryMaxAgeMs,
  stopTaskQueueInstance,
  TaskQueueCloseTimeoutError,
  taskQueue,
} from './core/task-queue.js';
import { transitionTask } from './core/task-state.js';
import { loadCronJobs, stopCronScheduler } from './core/cron-scheduler.js';
import { startWorkReportScheduler } from './core/work-report-scheduler.js';
import { discussionEngine } from './core/discussion-engine.js';
import { loadEnabledProviders } from './utils/config.js';
import { createGateway } from './server/gateway.js';
import { providerRuntimeCoordinator } from './core/provider-runtime-coordinator.js';
import { wsBridge } from './server/websocket.js';
import { getMonitorHTML } from './server/monitor.js';
import { getTopologyHTML } from './server/topology.js';
import { providerProber } from './core/provider-prober.js';
import { startTeamLifecycleEventMonitor } from './core/team-lifecycle.js';
import { runHourlyRoleAudit } from './core/hourly-role-oversight.js';
import { resumeCompanyRuns } from './core/company-orchestrator.js';
import { resumeHarnessRuns } from './server/routes/harness.js';
import { recordLearningEvent } from './core/failure-learning.js';
import {
  decideOrphanRecovery,
  isExternalInjectionGuardEnabled,
  isExternallyInjectedOrphan,
  isInteractiveRecoveryTask,
  pickHealthyRecoveryProvider,
  restoreOrphanExecutionContract,
  type RecoverableTaskStatus,
} from './core/orphan-recovery-policy.js';
import { resolveProviderRateLimitAdmission } from './core/rate-limit-state.js';
import { runWithConcurrency } from './utils/bounded-concurrency.js';
import { recordProcessLifecycle } from './utils/process-lifecycle-audit.js';
import { notifyProcessManagerReady } from './utils/process-readiness.js';
import {
  reapOwnedRuntimeProcesses,
} from './core/runtime-process-registry.js';
import { runtimeHygieneController } from './core/runtime-hygiene-controller.js';
import { startLocalInferenceHygiene, stopLocalInferenceHygiene } from './core/local-inference-hygiene.js';
import { normalizeModelSelectionSource } from './core/provider-catalog.js';

const log = createLogger('main');
const SHUTDOWN_DRAIN_TIMEOUT_MS = 15_000;
const SHUTDOWN_POLL_INTERVAL_MS = 1_000;
const SHUTDOWN_INTERRUPT_GRACE_MS = 1_000;
const SHUTDOWN_FINAL_TEARDOWN_MARGIN_MS = 1_000;
const SHUTDOWN_HARD_EXIT_MS = Math.max(
  SHUTDOWN_DRAIN_TIMEOUT_MS + 5_000,
  Number(process.env.NCO_SHUTDOWN_HARD_EXIT_MS) || 40_000,
);
const IN_FLIGHT_SHUTDOWN_STATUSES = ['assigned', 'in_progress', 'running', 'streaming'] as const;
const SHUTDOWN_ORPHAN_REASON = 'orphaned: graceful shutdown timeout';
const ORPHAN_RECOVERY_CONCURRENCY = Math.max(
  1,
  Math.floor(Number(process.env.NCO_ORPHAN_RECOVERY_CONCURRENCY) || 2),
);
const ORPHAN_RECOVERY_SCAN_MS = Math.max(
  10_000,
  Math.floor(Number(process.env.NCO_ORPHAN_RECOVERY_SCAN_MS) || 30_000),
);

let gateway: Awaited<ReturnType<typeof createGateway>> | null = null;
let shutdownPromise: Promise<void> | null = null;
let receivedShutdownSignal: string | null = null;
let orphanRecoveryTimer: ReturnType<typeof setInterval> | null = null;
let orphanRecoveryInFlight = false;

recordProcessLifecycle('startup');
process.on('uncaughtExceptionMonitor', (error, origin) => {
  recordProcessLifecycle('uncaught_exception', {
    origin,
    errorName: error.name,
    errorMessage: error.message.slice(0, 2_000),
    errorStack: error.stack?.slice(0, 8_000),
  });
});
process.on('exit', code => {
  recordProcessLifecycle('exit', {
    code,
    signal: receivedShutdownSignal ?? undefined,
  });
});
let stopWorkReportScheduler: (() => void) | null = null;
let stopTeamLifecycleEventMonitor: (() => void) | null = null;

/** 재큐잉 대상 orphan (부팅 후 taskQueue 준비되면 실제 enqueue) */
interface OrphanRequeue {
  taskId: string;
  agentId: string;
  prompt: string;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  verifier?: { type: 'run'; command: string; timeoutMs?: number };
  priority?: number;
  metadata?: Record<string, unknown>;
}

/** poison task(재시작을 유발한 태스크)의 무한 재큐잉을 막는 상한 */
const MAX_ORPHAN_REQUEUE = 2;

/**
 * B: 위임 대상 프로바이더가 가용하지 않으면(circuit open 등) 건강한 대체 프로바이더를 고른다.
 * 같은 role 우선, 없으면 아무 available. 하나도 없으면 null(→ 재큐잉 보류).
 * "리밋/다운 걸린 프로바이더에 위임하지 않는다"의 핵심 로직.
 */
function pickHealthyProvider(preferredId: string): string | null {
  const enabledIds = agentManager.listEnabledIds();
  return pickHealthyRecoveryProvider(
    preferredId,
    enabledIds.map(id => ({
      id,
      role: agentManager.getProvider(id)?.role,
      enabled: true,
      // P0-6: 'probe'(half-open)를 건강하다고 오판하면 부팅 재큐잉이 아직 검증되지 않은
      // 프로바이더로 orphan을 재배정해 poison이 재생산된다. available만 신뢰한다.
      circuitAvailable: circuitBreakerRegistry.getAvailability(id).available,
      // dashboard/API의 active DB rate-limit은 circuit과 독립적이므로 함께 검사한다.
      // DB admission을 읽을 수 없는 경우 helper가 fail-closed를 반환한다.
      rateLimitAdmitted: resolveProviderRateLimitAdmission(id).allowed,
    })),
  );
}

/**
 * 부팅 시 queued/in-flight 태스크 복구.
 * 기존: 전부 failed+dead-letter로 종결(재시작마다 대량 실패 발생 — task 실패 근본원인 A).
 * 변경: 재큐잉 카운트 < MAX면 status='queued'로 되돌리고 재큐잉 목록에 담아 반환한다.
 *       (부팅 후 taskQueue.enqueue로 실제 재실행). agent 없음/poison(상한 초과)만 dead-letter.
 */
function recoverOrphanedTasks(options: { periodic?: boolean } = {}): {
  requeued: OrphanRequeue[];
  deadLettered: number;
  deferred: number;
} {
  const db = getDb();
  const orphans = db.prepare(`
    SELECT t.id, t.status, t.mode, t.assigned_to, t.prompt, t.system_prompt, t.verifier_json,
           t.orphan_requeue_count, t.metadata_json, t.team_id, t.spawned_by_cli,
           t.priority, t.created_at, t.recovery_policy, t.queue_owner_instance_id,
           t.queue_owner_epoch, t.queue_expires_at, t.queue_executor_instance_id,
           EXISTS (
             SELECT 1 FROM discussions d
             WHERE d.task_id=t.id AND d.status='active'
           ) AS has_active_discussion
    FROM tasks t
    WHERE t.status IN ('queued', 'assigned', 'in_progress', 'running', 'streaming')
      ${options.periodic ? "AND t.created_at <= datetime('now', '-35 seconds')" : ''}
  `).all() as Array<{
    id: string; status: RecoverableTaskStatus; mode: string | null;
    assigned_to: string | null; prompt: string;
    system_prompt: string | null; verifier_json: string | null; orphan_requeue_count: number;
    metadata_json: string | null; team_id: string | null; spawned_by_cli: string | null;
    priority: number | null;
    created_at: string | null; recovery_policy: string | null;
    queue_owner_instance_id: string | null; queue_owner_epoch: number | null;
    queue_expires_at: string | null; queue_executor_instance_id: string | null;
    has_active_discussion: number;
  }>;

  // 외부 cron이 raw sqlite3로 직접 넣은 행은 재큐잉하지 않는다(isExternallyInjectedOrphan 주석 참조).
  const externalInjectionGuard = isExternalInjectionGuardEnabled();

  const insertDeadLetter = db.prepare(`
    INSERT INTO dead_letter_tasks (task_id, ai, prompt, reason)
    VALUES (?, ?, ?, ?)
  `);
  const requeued: OrphanRequeue[] = [];
  let deadLettered = 0;
  let deferred = 0;

  const handleOne = db.transaction((task: typeof orphans[number]): OrphanRequeue | null => {
    const persistedContract = restoreOrphanExecutionContract({
      metadataJson: task.metadata_json,
      verifierJson: task.verifier_json,
      priority: task.priority,
    });
    const metadataOwnerInstanceId = typeof persistedContract.metadata?.ncoQueueOwnerInstanceId === 'string'
      ? persistedContract.metadata.ncoQueueOwnerInstanceId
      : null;
    const metadataOwnerEpoch = Number(persistedContract.metadata?.ncoQueueOwnerEpoch);
    const decision = decideOrphanRecovery({
      status: task.status,
      assignedTo: task.assigned_to,
      recoveryCount: task.orphan_requeue_count ?? 0,
      maxRecoveryCount: MAX_ORPHAN_REQUEUE,
      recoveryPolicy: task.recovery_policy,
      interactive: isInteractiveRecoveryTask(task.mode, persistedContract.metadata),
      ownerInstanceId: task.queue_owner_instance_id,
      ownerEpoch: task.queue_owner_epoch,
      metadataOwnerInstanceId,
      metadataOwnerEpoch: Number.isSafeInteger(metadataOwnerEpoch) ? metadataOwnerEpoch : null,
      queueExpiresAt: task.queue_expires_at,
      ownerAlive: isTaskQueueInstanceLive(db, task.queue_owner_instance_id),
      executorAlive: isTaskQueueInstanceLive(db, task.queue_executor_instance_id),
      createdAt: task.created_at,
      maxAgeMs: resolveTaskQueueRecoveryMaxAgeMs(),
      externallyInjected: externalInjectionGuard && isExternallyInjectedOrphan({
        teamId: task.team_id,
        metadataJson: task.metadata_json,
        systemPrompt: task.system_prompt,
        spawnedByCli: task.spawned_by_cli,
        orphanRequeueCount: task.orphan_requeue_count ?? 0,
      }),
      orchestrationOwned: task.has_active_discussion === 1,
    });
    if (decision.action === 'skip') {
      deferred += 1;
      return null;
    }
    if (decision.action === 'dead_letter') {
      // 모든 reason은 'orphaned:' 접두사 — team-scorer의 INFRA_EXCLUSION이 이미 커버해
      // 팀 완료율에 계상되지 않는다.
      const reason = decision.reason === 'no_agent'
        ? 'orphaned: server restart (no agent)'
        : decision.reason === 'external_injection'
          ? 'orphaned: external injection (not created by NCO — never dispatched)'
          : decision.reason === 'orchestration_restart'
            ? 'orphaned: multi-agent orchestration interrupted by server restart'
            : decision.reason === 'resume_not_explicit'
              ? 'orphaned: action_required (startup resume was not explicitly authorized)'
              : decision.reason === 'interactive'
                ? 'orphaned: action_required (interactive prompt replay blocked)'
                : decision.reason === 'ownership_unknown'
                  ? 'orphaned: action_required (queue ownership unknown)'
                  : decision.reason === 'queue_lease_unknown'
                    ? 'orphaned: action_required (queue ownership lease unknown)'
                    : decision.reason === 'age_unknown'
                      ? 'orphaned: action_required (task age unknown)'
                      : decision.reason === 'too_old'
                        ? 'orphaned: action_required (task exceeded startup recovery age)'
                        : `orphaned: server restart (poison — requeued ${task.orphan_requeue_count}x)`;
      const moved = transitionTask(db, task.id, 'failed', { error: reason, completedAt: true });
      if (moved.ok) insertDeadLetter.run(task.id, task.assigned_to, task.prompt, reason);
      if (moved.ok && decision.reason === 'orchestration_restart') {
        db.prepare(`
          UPDATE discussions
          SET status='failed', report=?, ended_at=datetime('now'), updated_at=datetime('now')
          WHERE task_id=? AND status='active'
        `).run(reason, task.id);
        recordLearningEvent({
          agentId: task.assigned_to ?? 'system',
          eventType: 'orphan_orchestration',
          pattern: reason,
          context: { taskId: task.id },
        }, db);
      }
      if (decision.reason === 'poison') {
        recordLearningEvent({
          agentId: task.assigned_to ?? 'system',
          eventType: 'orphan_poison',
          pattern: reason,
          context: {
            taskId: task.id,
            orphanRequeueCount: task.orphan_requeue_count,
          },
        }, db);
      }
      if (moved.ok) deadLettered++;
      return null;
    }
    const recoveryAgentId = pickHealthyProvider(task.assigned_to!);
    if (!recoveryAgentId) {
      // Do not consume a recovery generation until it can actually be handed
      // to a provider. The periodic scanner retries when admission recovers.
      deferred += 1;
      return null;
    }
    // status가 이미 queued인 행도 owner/epoch/expiry/executor/count 전체를 CAS하여
    // 여러 backend/worker가 같은 세대를 동시에 회수하지 못하게 한다.
    const claim = claimTaskForStartupRecovery(db, {
      taskId: task.id,
      status: task.status,
      recoveryCount: task.orphan_requeue_count ?? 0,
      metadataJson: task.metadata_json,
      ownerInstanceId: task.queue_owner_instance_id,
      ownerEpoch: task.queue_owner_epoch,
      queueExpiresAt: task.queue_expires_at,
      executorInstanceId: task.queue_executor_instance_id,
    });
    if (!claim.claimed) return null;
    const executionContract = restoreOrphanExecutionContract({
      metadataJson: claim.metadataJson,
      verifierJson: task.verifier_json,
      priority: task.priority,
    });
    return {
      taskId: task.id,
      agentId: recoveryAgentId,
      prompt: task.prompt,
      systemPrompt: task.system_prompt ?? undefined,
      ...executionContract,
    };
  });

  for (const task of orphans) {
    const r = handleOne(task);
    if (r) requeued.push(r);
  }

  return { requeued, deadLettered, deferred };
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

async function dispatchRecoveredTasks(requeued: readonly OrphanRequeue[]): Promise<void> {
  let reEnqueued = 0;
  let reRouted = 0;
  let deferred = 0;

  const processed = await runWithConcurrency(
    requeued,
    ORPHAN_RECOVERY_CONCURRENCY,
    async o => {
      let target = pickHealthyProvider(o.agentId);
      if (!target) {
        deferred += 1;
        log.warn(
          { taskId: o.taskId, agent: o.agentId },
          'orphan re-enqueue보류 — 건강한 프로바이더 없음(다음 부팅 재시도)',
        );
        return;
      }
      if (target !== o.agentId) {
        try {
          // Interrupted recovery already advanced N→N+1 in recoverOrphanedTasks.
          // Select the healthy route inside that same unclaimed generation;
          // advancing again here would incorrectly skip to N+2.
          const rerouted = persistTaskQueueAttempt(
            o.taskId,
            o.metadata?.ncoQueueAttempt,
            target,
          );
          target = rerouted.agentId;
          o.metadata = rerouted.metadata;
        } catch (error) {
          const duplicate = duplicateExecutionResultFromError(error);
          if (duplicate) {
            log.info(
              { taskId: o.taskId, queueOutcome: duplicate.queueOutcome },
              'Skipped competing orphan recovery route',
            );
            return;
          }
          throw error;
        }
        if (target !== o.agentId) {
          log.info({ taskId: o.taskId, from: o.agentId, to: target }, 'orphan re-routed to healthy provider');
          reRouted += 1;
        } else {
          log.info(
            { taskId: o.taskId, agentId: target },
            'Joined the durable orphan recovery route selected by another scheduler',
          );
        }
      }

      try {
        reEnqueued += 1;
        const result = await taskQueue.enqueue({
          taskId: o.taskId,
          agentId: target,
          prompt: o.prompt,
          model: o.model,
          systemPrompt: o.systemPrompt,
          timeoutMs: o.timeoutMs,
          verifier: o.verifier,
          priority: o.priority,
          metadata: o.metadata,
        });
        if (isTaskExecutionJoinOutcome(result)) {
          log.info(
            { taskId: o.taskId, queueOutcome: result.queueOutcome },
            'Skipped recovered task terminal update for joined execution',
          );
          return;
        }
        const moved = persistRecoveredTaskResult(getDb(), o.taskId, result);
        if (!moved.ok) {
          log.warn(
            { taskId: o.taskId, prev: moved.prev, resultStatus: result.status },
            'Skipped recovered task terminal update',
          );
        } else if (gateway) {
          try {
            await gateway.settlePersistedTaskTerminal(o.taskId);
          } catch (settleError) {
            // The execution result is already durable. Audit delivery and other
            // side effects are retried by their reconcilers and must not rewrite
            // a successful recovered execution as a provider failure.
            log.warn({
              taskId: o.taskId,
              err: settleError instanceof Error ? settleError.message : String(settleError),
            }, 'Failed to settle recovered task terminal side effects');
          }
        }
      } catch (error) {
        const duplicate = duplicateExecutionResultFromError(error);
        if (duplicate) {
          log.info(
            { taskId: o.taskId, queueOutcome: duplicate.queueOutcome },
            'Skipped recovered task failure update for competing execution',
          );
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        const moved = persistRecoveredTaskResult(getDb(), o.taskId, {
          success: false,
          output: '',
          error: message,
          status: 'failed',
        });
        if (moved.ok && gateway) {
          try {
            await gateway.settlePersistedTaskTerminal(o.taskId);
          } catch (settleError) {
            log.warn({
              taskId: o.taskId,
              err: settleError instanceof Error ? settleError.message : String(settleError),
            }, 'Failed to settle recovered task failure side effects');
          }
        }
        log.warn(
          { taskId: o.taskId, err: message, persisted: moved.ok, prev: moved.prev },
          'Orphan re-enqueue failed',
        );
      }
    },
    () => shutdownPromise === null,
  );

  log.info({
    total: requeued.length,
    processed,
    reEnqueued,
    reRouted,
    deferred,
    concurrency: ORPHAN_RECOVERY_CONCURRENCY,
    interrupted: processed < requeued.length,
  }, 'Startup orphan recovery dispatcher settled');
}

function startOrphanRecoveryMonitor(): void {
  if (orphanRecoveryTimer) return;
  orphanRecoveryTimer = setInterval(() => {
    if (shutdownPromise || orphanRecoveryInFlight) return;
    orphanRecoveryInFlight = true;
    try {
      const recovery = recoverOrphanedTasks({ periodic: true });
      if (recovery.requeued.length > 0 || recovery.deadLettered > 0) {
        log.warn({
          requeue: recovery.requeued.length,
          deadLetter: recovery.deadLettered,
          deferred: recovery.deferred,
        }, 'Periodic orphan recovery processed');
      }
      if (recovery.requeued.length > 0) {
        void dispatchRecoveredTasks(recovery.requeued).catch(error => {
          log.error({
            error: error instanceof Error ? error.message : String(error),
          }, 'Periodic orphan recovery dispatcher failed');
        });
      }
    } catch (error) {
      log.warn({
        error: error instanceof Error ? error.message : String(error),
      }, 'Periodic orphan recovery scan failed');
    } finally {
      orphanRecoveryInFlight = false;
    }
  }, ORPHAN_RECOVERY_SCAN_MS);
  orphanRecoveryTimer.unref?.();
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
  const retryStartupSqliteWrite = <T>(operation: () => T | Promise<T>, stage: string) => (
    withSqliteBusyRetry(operation, {
      onRetry: context => log.warn({ stage, ...context }, 'Startup SQLite write contention; retrying'),
    })
  );
  await retryStartupSqliteWrite(() => runMigrations(), 'migrations');
  const queueInstanceReconcile = await retryStartupSqliteWrite(
    () => reconcileStaleTaskQueueInstances(db),
    'queue-instance-reconcile',
  );
  if (queueInstanceReconcile.staleMarkedStopped > 0 || queueInstanceReconcile.historyRemoved > 0) {
    log.warn(queueInstanceReconcile, 'Startup task queue instance history reconciled');
  }
  taskQueue.startOwnershipHeartbeat('backend');
  const teamCircuitReconcile = await retryStartupSqliteWrite(
    () => reconcileLegacyTeamCircuits(db),
    'legacy-team-circuit-reconcile',
  );
  log.warn(teamCircuitReconcile, 'Startup legacy team circuit reconciliation completed');

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
  await retryStartupSqliteWrite(() => sharedState.seedProviders(), 'provider-seed');

  // 5. Recovery sync (SQLite → Redis)
  await syncEngine.recoverySync();

  // 6. Start periodic sync (Redis → SQLite)
  syncEngine.start();

  // 7. Agent Manager
  log.info('Initializing Agent Manager...');
  await agentManager.init();

  const orphanRecovery = recoverOrphanedTasks();
  log.warn({
    requeue: orphanRecovery.requeued.length,
    deadLetter: orphanRecovery.deadLettered,
    deferred: orphanRecovery.deferred,
  }, 'Startup orphan recovery processed');

  // 7b. Task Queue (BullMQ per-agent, falls back to semaphore if Redis offline)
  log.info('Initializing Task Queue...');
  taskQueue.setExecutor(async (task, signal) => {
    const result = await agentManager.executeTask(task.agentId, task.prompt, {
      taskId: task.taskId,
      systemPrompt: task.systemPrompt,
      model: task.model,
      modelSelection: normalizeModelSelectionSource(task.metadata?.modelSelection),
      signal,
      timeoutMs: task.timeoutMs,
      projectDir: task.metadata?.projectDir as string | undefined,
      localNetworkAccess: task.metadata?.localNetworkAccess === true,
    });
    return { success: result.success, output: result.output, error: result.error, usage: result.usage };
  });
  await providerRuntimeCoordinator.init();
  await taskQueue.init(loadEnabledProviders());
  runtimeHygieneController.start('backend');

  // 로컬 추론 서버(ollama)는 NCO 밖 프로세스라 기존 위생 대상이 아니다. 그런데 그쪽이
  // 꼬이면 NCO 태스크가 통째로 죽는다 — 2026-08-06 실측으로 ollama 태스크 58/58 이
  // `lease_expired` 였고 실제 프로바이더 오류는 0건이었다. 원인은 멈춘 llama-server 2개가
  // 스케줄러 슬롯을 12시간 점유해 대기 큐가 만원이 된 것이었고, `/api/generate` 가
  // 부하 0에서도 503을 냈다. 주기적으로 그 상태를 보고 고아를 거둔다.
  startLocalInferenceHygiene({
    targetModel: loadEnabledProviders().find(p => p.id === 'ollama')?.model ?? undefined,
  });

  // 7c. Internal cron jobs
  loadCronJobs();

  // 7d. Startup repair audit
  try {
    const { runOrganizationDesignAudit } = await import('./core/organization-design-audit.js');
    runOrganizationDesignAudit({ database: db, source: 'startup', repair: true });
    log.info('Startup organization design audit completed');
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'Startup organization design audit failed');
  }

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
  const resumedCompanyRuns = resumeCompanyRuns(gateway);
  const resumedHarnessRuns = resumeHarnessRuns();
  if (resumedCompanyRuns > 0 || resumedHarnessRuns > 0) {
    log.warn({
      companyRuns: resumedCompanyRuns,
      harnessRuns: resumedHarnessRuns,
    }, 'Durable orchestration runs resumed after startup');
  }
  stopTeamLifecycleEventMonitor = startTeamLifecycleEventMonitor(db);
  try {
    const hourlyAudit = runHourlyRoleAudit({ database: db, source: 'startup' });
    log.info({
      hrStatus: hourlyAudit.hr.status,
      selfImprovementStatus: hourlyAudit.selfImprovement.status,
      goalCoverage: hourlyAudit.goalCoverage,
    }, 'Startup HR role and goal coverage audit completed');
  } catch (error) {
    log.warn({
      error: error instanceof Error ? error.message : String(error),
    }, 'Startup HR role and goal coverage audit failed');
  }

  try {
    const {
      recordPerformanceGovernanceCatchup,
      runPerformanceGovernance,
    } = await import('./core/performance-governance.js');
    const { runCommanderOperationAudit } = await import('./core/commander-operation-audit.js');

    const govResult = runPerformanceGovernance({ database: db });
    const caughtUpPerformanceJobs = recordPerformanceGovernanceCatchup({
      database: db,
      source: 'startup',
    });
    const auditResult = runCommanderOperationAudit({
      database: db,
      source: 'startup',
    });

    log.info(
      { govResult, caughtUpPerformanceJobs, auditResult },
      'Startup performance governance and commander audit completed',
    );
  } catch (error) {
    log.warn({
      error: error instanceof Error ? error.message : String(error),
    }, 'Startup performance governance and commander audit failed');
  }

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

  // PM2 wait_ready contract: never advertise `online` before both HTTP and WS
  // listeners are established. Direct node/isolated boots have no IPC sender
  // and continue normally without a readiness notification.
  const processManagerNotified = notifyProcessManagerReady();
  log.info({
    api: env.PORT,
    ws: env.WS_PORT,
    processManagerNotified,
  }, 'NCO Backend fully operational');
  log.info('Monitor: http://localhost:' + env.PORT + '/monitor');
  if (process.env.NCO_PROBER !== '0') providerProber.start();

  // API/WS가 먼저 살아난 뒤 복구 작업을 제한된 수로 실행한다. 이전 구현은 부팅 중
  // 185개 enqueue promise를 동시에 시작해 SQLite busy wait로 이벤트 루프와 /health를 굶겼다.
  if (orphanRecovery.requeued.length > 0) {
    void dispatchRecoveredTasks(orphanRecovery.requeued).catch(error => {
      log.error({
        error: error instanceof Error ? error.message : String(error),
      }, 'Startup orphan recovery dispatcher failed');
    });
  }
  startOrphanRecoveryMonitor();
}

// ─── Graceful Shutdown ────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const shutdownStartedAt = Date.now();
    const hardExitTimer = setTimeout(() => {
      log.error({
        signal,
        timeoutMs: SHUTDOWN_HARD_EXIT_MS,
      }, 'Shutdown hard deadline reached; exiting before process-manager SIGKILL');
      process.exit(0);
    }, SHUTDOWN_HARD_EXIT_MS);
    hardExitTimer.unref();

    taskQueue.beginShutdown(signal);
    runtimeHygieneController.beginDrain();
    if (orphanRecoveryTimer) {
      clearInterval(orphanRecoveryTimer);
      orphanRecoveryTimer = null;
    }
    log.info({ signal }, 'Shutting down...');
    providerProber.stop();
    stopCronScheduler();
    if (stopWorkReportScheduler) {
      stopWorkReportScheduler();
      stopWorkReportScheduler = null;
    }
    if (stopTeamLifecycleEventMonitor) {
      stopTeamLifecycleEventMonitor();
      stopTeamLifecycleEventMonitor = null;
    }
    if (gateway) {
      await gateway.close();
      log.info('API Gateway closed to new requests');
    }

    const drainResult = await waitForInFlightDrain(SHUTDOWN_DRAIN_TIMEOUT_MS);
    if (drainResult.drained) {
      log.info('In-flight task drain completed before shutdown timeout');
    } else {
      const orphaned = markInFlightTasksAsOrphaned(drainResult.remaining);
      const remainingTaskIds = drainResult.remaining.map(task => task.id);
      const interrupted = taskQueue.interruptActiveTasks(remainingTaskIds);
      let cancelledDiscussions = 0;
      for (const taskId of remainingTaskIds) {
        cancelledDiscussions += discussionEngine.cancelTaskDiscussions(taskId);
      }
      // Give AbortSignal-aware CLIs a short cooperative exit window, then use
      // the runtime registry's PID+PGID+command fingerprint as the force gate.
      await sleep(SHUTDOWN_INTERRUPT_GRACE_MS);
      const providerProcesses = await reapOwnedRuntimeProcesses(remainingTaskIds);
      log.warn({
        timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
        remaining: drainResult.remaining.length,
        orphaned,
        interrupted,
        cancelledDiscussions,
        providerProcesses,
        taskIds: drainResult.remaining.map(task => task.id),
      }, 'Shutdown drain timed out; remaining work interrupted and provider processes reaped');
    }

    await wsBridge.stop(signal);
    await sessionManager.destroy();
    // Keep AgentManager's captured provider generations and execution tracking
    // alive until every queue processor callback settles. Clearing it first can
    // race post-provider verification/vector writes that are still unwinding.
    const executionExitWaitMs = Math.min(
      30_000,
      Math.max(
        0,
        SHUTDOWN_HARD_EXIT_MS
          - (Date.now() - shutdownStartedAt)
          - SHUTDOWN_FINAL_TEARDOWN_MARGIN_MS,
      ),
    );
    try {
      await taskQueue.close({ forceWorkers: true, executionExitWaitMs });
    } catch (error) {
      if (error instanceof TaskQueueCloseTimeoutError) {
        // Fail closed without producing an unhandled-rejection exit=1. The
        // queue instance remains draining, its ownership heartbeat and queue
        // transports remain live, and the existing hard deadline performs the
        // final process exit if a non-abortable post-task gate never settles.
        log.error({
          signal,
          timeoutMs: error.timeoutMs,
          taskIds: error.taskIds,
          externalExecutionIds: error.externalExecutionIds,
        }, 'Task queue execution barrier did not settle; deferring final teardown to hard deadline');
        return;
      }
      throw error;
    }
    agentManager.destroy();
    providerRuntimeCoordinator.stop();
    stopLocalInferenceHygiene();
    await runtimeHygieneController.stop();
    await syncEngine.stop();
    eventBus.destroy();
    await closeRedis();
    closeDb();
    clearTimeout(hardExitTimer);
    process.exit(0);
  })();
  return shutdownPromise;
}

function handleShutdownSignal(signal: 'SIGINT' | 'SIGTERM'): void {
  receivedShutdownSignal ??= signal;
  recordProcessLifecycle('signal', { signal });
  void shutdown(signal);
}

process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));

// ─── Run ──────────────────────────────────────────────
boot().catch(async err => {
  log.fatal({ err }, 'Boot failed');
  try {
    stopTaskQueueInstance(getDb());
    stopLocalInferenceHygiene();
    await runtimeHygieneController.stop();
  } catch (cleanupError) {
    log.warn({
      err: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    }, 'Boot failure ownership cleanup failed');
  }
  process.exit(1);
});

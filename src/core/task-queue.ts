/**
 * TaskQueueManager — BullMQ-backed per-agent task queue
 *
 * Each agent gets its own Queue + Worker with concurrency capped at
 * provider.concurrency (from ai-providers.json).
 *
 * Fallback: if Redis is unavailable, a simple in-memory semaphore
 * limits concurrency so CLI processes don't conflict.
 */

import {
  DelayedError,
  Queue,
  Worker,
  Job,
  QueueEvents,
  UnrecoverableError,
  type JobType,
} from 'bullmq';
import type Database from 'better-sqlite3';
import { isProviderErrorBody } from './provider-error-body.js';
import { spawn, execFileSync, type ChildProcessByStdio, execSync } from 'child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'stream';
import { mkdtempSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir, availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { isRedisConnected, getRedis } from '../storage/redis.js';
import { env, type ProviderConfig } from '../utils/config.js';
import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';
import { invocationTracker } from './invocation-tracker.js';
import { CommandGate } from '../security/command-gate.js';
import {
  collectTrustedToolEvidence,
  extractTaskEvidenceJson,
  type PersistedToolAction,
} from './task-evidence.js';
import { requireEvidence } from '../security/evidence-gate.js';
import { paLifecycle } from './ported-integrations.js';
import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';
import { classifyTaskFailureForCircuit } from './task-failure-circuit.js';
import {
  acknowledgeTaskLease,
  DEFAULT_QUEUE_WAIT_MAX_MS,
  recordTaskHeartbeat,
} from './lease-sweeper.js';
import { appendAttemptedAgent, decideFinalEscalation, getAttemptedAgents } from './task-escalation.js';
import { resolveExecutorChain, providerModelDispatchable, type TeamRow, type AvailabilityFn } from './company-orchestrator.js';
import {
  listActivelyRateLimited,
  resolveProviderRateLimitAdmission,
} from './rate-limit-state.js';
import { logDecision } from './decision-log.js';
import { recordLearningEvent } from './failure-learning.js';
import { registeredProviders } from './provider-registry.js';
import { transitionTask, TERMINAL_STATES } from './task-state.js';
import {
  DEFAULT_ORPHAN_RECOVERY_MAX_AGE_MS,
  resolveExplicitTaskRecoveryPolicy,
} from './orphan-recovery-policy.js';
import {
  PROVIDER_TASK_CAPABILITIES,
  MODEL_WORKLOAD_TIERS,
  resolveProviderModel,
  resolveProviderModelForTaskType,
  resolveProviderModelOverrideForTaskType,
  type CatalogTaskType,
  type ModelSelectionSource,
  type ModelWorkloadTier,
} from './provider-catalog.js';
import {
  registerRuntimeProcess,
  registerRuntimeSessionProcess,
  touchRuntimeSessionProcess,
  unregisterRuntimeProcess,
  unregisterRuntimeSessionProcess,
  type ProcessRegistryDependencies,
} from './runtime-process-registry.js';
import { providerGenerationGate } from './provider-generation-gate.js';
import { isProviderQualified } from './provider-qualification.js';
import {
  discoverRetiredBullMqQueues,
  markNcoBullMqQueueOwnership,
  type RetiredBullMqQueueDiscovery,
} from './retired-bullmq-queue-hygiene.js';

// ─── Rate Limit Detection ─────────────────────────────
const RATE_LIMIT_PATTERNS = [
  /rate.limit/i,
  /too many requests/i,
  /429/,
  /quota.exceeded/i,
  /usage limit/i,
  /weekly limit/i,
  /monthly limit/i,
  /resource.exhausted/i,
  /slowdown/i,
];

function isRateLimitError(message: string): boolean {
  return RATE_LIMIT_PATTERNS.some(p => p.test(message));
}

const HARD_QUOTA_PATTERNS = [
  /\bquota(?: exceeded)?\b/i,
  /\busage limit\b/i,
  /\bweekly limit\b/i,
  /\bmonthly limit\b/i,
  /\bcredit balance is too low\b/i,
];

/** Long-lived account quota cannot recover through second-scale retry backoff. */
export function isHardQuotaError(message: string): boolean {
  return HARD_QUOTA_PATTERNS.some(pattern => pattern.test(message));
}

// ─── Retry Config ─────────────────────────────────────
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 5_000; // 5s, then 10s, then 20s
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_BULLMQ_LOCK_DURATION_MS = 5 * 60_000;

export function resolveBullMqLockDurationMs(
  raw: unknown = process.env.NCO_BULLMQ_LOCK_DURATION_MS,
): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 3 * 60_000
    ? Math.min(Math.trunc(parsed), 30 * 60_000)
    : DEFAULT_BULLMQ_LOCK_DURATION_MS;
}

// BullMQ renews a live worker's lock periodically, so lockDuration is a crash
// recovery ceiling rather than a task runtime ceiling. Five minutes tolerates
// measured event-loop/Redis jitter while avoiding 22 minutes of ghost capacity
// after an ungraceful process exit. Operators can raise it through the bounded
// environment override when a host has unusually long event-loop pauses.
export const BULLMQ_LOCK_DURATION_MS = resolveBullMqLockDurationMs();
export const BULLMQ_JOB_ATTEMPTS = 1;
const TASK_MONITOR_INTERVAL_MS = 15_000;
// abort 를 건 뒤 프로바이더를 정리하고 finalizeRuntime 이 종료 상태를 쓰기까지의 유예.
// 이 구간에도 리스를 갱신해야 sweeper 가 진짜 사유(timeout(idle)·cancelled)를
// lease_expired 로 덮어쓰지 않는다. LEASE_DURATION_MS(90초)보다 길어야 의미가 있다.
const ABORT_UNWIND_GRACE_MS = 120_000;
// 큐 대기 중 리스 갱신 주기. LEASE_DURATION_MS(90초)보다 충분히 짧아야 한다.
const QUEUE_WAIT_HEARTBEAT_INTERVAL_MS = 30_000;
const PARTIAL_OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_VERIFIER_ALLOWLIST = ['node', 'npx', 'npm', 'git', 'curl', 'true', 'false', 'sleep', 'cat', 'ls', 'grep', 'ps', 'pgrep', 'sqlite3', 'tsc', 'vitest'];
const verifierAllowlist = (process.env.VERIFIER_ALLOWLIST ?? '')
  .split(',')
  .map(command => command.trim())
  .filter(Boolean);
const verifierCommandGate = new CommandGate({
  allowedCommands: verifierAllowlist.length > 0 ? verifierAllowlist : DEFAULT_VERIFIER_ALLOWLIST,
  deniedCommands: [],
});

const log = createLogger('task-queue');

/** Opaque scheduler identity shared by all queues in this process lifetime. */
export const TASK_QUEUE_OWNER_INSTANCE_ID: string = randomUUID();
export const TASK_QUEUE_INSTANCE_HEARTBEAT_MS = 10_000;
export const TASK_QUEUE_INSTANCE_STALE_MS = 35_000;
export const TASK_QUEUE_INSTANCE_HISTORY_LIMIT = 100;
export const DEFAULT_QUEUE_OWNERSHIP_LEASE_MS = 120_000;
export const EXECUTION_EXIT_WAIT_MS = 5_000;

export type TaskQueueInstanceRole = 'backend' | 'worker' | 'unknown';
export type TaskQueueInstanceState = 'running' | 'draining' | 'stopped';

export class TaskQueueCloseTimeoutError extends Error {
  readonly code = 'task_queue_close_timeout';

  constructor(
    readonly taskIds: readonly string[],
    readonly externalExecutionIds: readonly string[],
    readonly timeoutMs: number,
  ) {
    super('active task executions did not exit during queue close');
    this.name = 'TaskQueueCloseTimeoutError';
  }
}

function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForExecutionExit(
  hasLiveExecution: () => boolean,
  timeoutMs = EXECUTION_EXIT_WAIT_MS,
  pollMs = 25,
): Promise<boolean> {
  const boundedTimeout = Math.max(0, Math.min(30_000, Math.trunc(timeoutMs)));
  const boundedPoll = Math.max(5, Math.min(250, Math.trunc(pollMs)));
  const deadline = Date.now() + boundedTimeout;
  while (hasLiveExecution()) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>(resolveWait => {
      const timer = setTimeout(resolveWait, Math.min(boundedPoll, Math.max(1, deadline - Date.now())));
      timer.unref?.();
    });
  }
  return true;
}

export function resolveQueueOwnershipLeaseMs(
  raw: unknown = process.env.NCO_QUEUE_OWNERSHIP_LEASE_MS,
): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 30_000
    ? Math.min(Math.trunc(parsed), 10 * 60_000)
    : DEFAULT_QUEUE_OWNERSHIP_LEASE_MS;
}

function taskQueueInstanceTableAvailable(database: Database.Database): boolean {
  const row = database.prepare(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type='table' AND name='task_queue_instances'
  `).get() as { present?: number } | undefined;
  return row?.present === 1;
}

export function heartbeatTaskQueueInstance(
  database: Database.Database,
  input: {
    instanceId?: string;
    role?: TaskQueueInstanceRole;
    state?: Exclude<TaskQueueInstanceState, 'stopped'>;
    pid?: number;
    nowMs?: number;
  } = {},
): boolean {
  if (!taskQueueInstanceTableAvailable(database)) return false;
  const now = input.nowMs ?? Date.now();
  const state = input.state ?? 'running';
  database.prepare(`
    INSERT INTO task_queue_instances (
      instance_id, role, pid, state, started_at, heartbeat_at, stopped_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(instance_id) DO UPDATE SET
      role=CASE WHEN excluded.role='unknown'
        THEN task_queue_instances.role ELSE excluded.role END,
      pid=excluded.pid,
      state=CASE
        WHEN task_queue_instances.state='draining' AND excluded.state='running'
          THEN 'draining'
        ELSE excluded.state
      END,
      heartbeat_at=excluded.heartbeat_at,
      stopped_at=NULL
  `).run(
    input.instanceId ?? TASK_QUEUE_OWNER_INSTANCE_ID,
    input.role ?? 'unknown',
    input.pid ?? process.pid,
    state,
    now,
    now,
  );
  return true;
}

export function markTaskQueueInstanceDraining(
  database: Database.Database,
  instanceId = TASK_QUEUE_OWNER_INSTANCE_ID,
  nowMs = Date.now(),
): boolean {
  if (!taskQueueInstanceTableAvailable(database)) return false;
  const updated = database.prepare(`
    UPDATE task_queue_instances
    SET state='draining', heartbeat_at=?, stopped_at=NULL
    WHERE instance_id=? AND state IN ('running','draining')
  `).run(nowMs, instanceId);
  if (updated.changes === 1) return true;
  return heartbeatTaskQueueInstance(database, {
    instanceId,
    state: 'draining',
    nowMs,
  });
}

export function stopTaskQueueInstance(
  database: Database.Database,
  instanceId = TASK_QUEUE_OWNER_INSTANCE_ID,
  nowMs = Date.now(),
): void {
  if (!taskQueueInstanceTableAvailable(database)) return;
  database.prepare(`
    UPDATE task_queue_instances
    SET state='stopped', heartbeat_at=?, stopped_at=?
    WHERE instance_id=?
  `).run(nowMs, nowMs, instanceId);
}

export interface TaskQueueInstanceReconcileResult {
  examined: number;
  staleMarkedStopped: number;
  historyRemoved: number;
  remaining: number;
}

/**
 * Normalize crash leftovers before this process publishes its own heartbeat.
 * Rows are operational evidence rather than task data, so retain only a
 * bounded stopped history while never deleting a live or draining instance.
 */
export function reconcileStaleTaskQueueInstances(
  database: Database.Database,
  options: {
    nowMs?: number;
    staleMs?: number;
    historyLimit?: number;
    currentInstanceId?: string;
  } = {},
): TaskQueueInstanceReconcileResult {
  if (!taskQueueInstanceTableAvailable(database)) {
    return { examined: 0, staleMarkedStopped: 0, historyRemoved: 0, remaining: 0 };
  }
  const nowMs = options.nowMs ?? Date.now();
  const staleMs = Math.max(1, Math.trunc(options.staleMs ?? TASK_QUEUE_INSTANCE_STALE_MS));
  const historyLimit = Math.max(1, Math.trunc(
    options.historyLimit ?? TASK_QUEUE_INSTANCE_HISTORY_LIMIT,
  ));
  const currentInstanceId = options.currentInstanceId ?? TASK_QUEUE_OWNER_INSTANCE_ID;

  return database.transaction(() => {
    const examined = Number((database.prepare(`
      SELECT COUNT(*) AS count FROM task_queue_instances
    `).get() as { count: number }).count);
    const marked = database.prepare(`
      UPDATE task_queue_instances
      SET state='stopped', stopped_at=?, heartbeat_at=MAX(heartbeat_at, ?)
      WHERE instance_id<>?
        AND state IN ('running','draining')
        AND heartbeat_at<=?
    `).run(nowMs, nowMs, currentInstanceId, nowMs - staleMs);
    const removed = database.prepare(`
      DELETE FROM task_queue_instances
      WHERE instance_id IN (
        SELECT instance_id
        FROM task_queue_instances
        WHERE state='stopped' AND instance_id<>?
        ORDER BY COALESCE(stopped_at, heartbeat_at) DESC, instance_id DESC
        LIMIT -1 OFFSET ?
      )
    `).run(currentInstanceId, historyLimit);
    const remaining = Number((database.prepare(`
      SELECT COUNT(*) AS count FROM task_queue_instances
    `).get() as { count: number }).count);
    return {
      examined,
      staleMarkedStopped: Number(marked.changes),
      historyRemoved: Number(removed.changes),
      remaining,
    };
  }).immediate();
}

export function isTaskQueueInstanceLive(
  database: Database.Database,
  instanceId: string | null | undefined,
  nowMs = Date.now(),
  staleMs = TASK_QUEUE_INSTANCE_STALE_MS,
): boolean {
  if (!instanceId || !taskQueueInstanceTableAvailable(database)) return false;
  const row = database.prepare(`
    SELECT state, heartbeat_at
    FROM task_queue_instances
    WHERE instance_id=?
  `).get(instanceId) as { state: string; heartbeat_at: number } | undefined;
  return (row?.state === 'running' || row?.state === 'draining')
    && Number.isFinite(row.heartbeat_at)
    && row.heartbeat_at > nowMs - staleMs;
}

export function resolveTaskQueueRecoveryMaxAgeMs(
  raw: unknown = process.env.NCO_ORPHAN_RECOVERY_MAX_AGE_MS,
): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 60_000
    ? Math.min(Math.trunc(parsed), 24 * 60 * 60_000)
    : DEFAULT_ORPHAN_RECOVERY_MAX_AGE_MS;
}

export interface VerifierBuildStats {
  currentRunning: number;
  totalRuns: number;
  waiting: number;
  maxConcurrent: number;
}

const verifierBuildStats: VerifierBuildStats = {
  currentRunning: 0,
  totalRuns: 0,
  waiting: 0,
  maxConcurrent: 0,
};

export function getVerifierBuildStats(): VerifierBuildStats {
  return { ...verifierBuildStats };
}

// hermes는 2026-07-18 codex CLI로 전환 — 로컬 OOM 동시성 하향 대상 아님(정적 동시성 사용).
const DYNAMIC_LOCAL_CONCURRENCY_IDS = new Set(['ollama']);

// ─── Types ────────────────────────────────────────────
export interface QueuedTask {
  taskId: string;
  agentId: string;
  prompt: string;
  model?: string;
  systemPrompt?: string;
  /** Per-task wall-clock override (ms) — falls back to sandbox default when unset */
  timeoutMs?: number;
  verifier?: {
    type: 'run';
    command: string;
    timeoutMs?: number;
  };
  priority?: number;
  metadata?: {
    invocationId?: string;
    [key: string]: unknown;
  };
}

export type QueueModelSelection = ModelSelectionSource;

export interface QueuedTaskModelResolution {
  /** Canonical model recorded in durable provenance. */
  model?: string;
  /**
   * A real task-level override safe to forward to the provider executor.
   * Provider defaults and routing aliases stay out of the CLI/API override
   * channel; the provider adapter already owns those defaults.
   */
  executorModel?: string;
  selection: QueueModelSelection;
  taskType?: CatalogTaskType;
  requestedModel?: string;
  metadataPatch: Record<string, unknown>;
}

export class QueueModelResolutionError extends Error {
  readonly code = 'queue_model_resolution_failed';

  constructor(
    readonly providerId: string,
    readonly reason: string,
    readonly requestedModel?: string,
  ) {
    super(`queue_model_resolution_failed: ${providerId}: ${reason}`);
    this.name = 'QueueModelResolutionError';
  }
}

const QUEUE_MODEL_TASK_TYPES = new Set<CatalogTaskType>(
  Object.keys(PROVIDER_TASK_CAPABILITIES) as CatalogTaskType[],
);
const QUEUE_MODEL_WORKLOADS = new Set<ModelWorkloadTier>(MODEL_WORKLOAD_TIERS);

function nonEmptyMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function queueModelTaskType(metadata: Record<string, unknown>): CatalogTaskType | undefined {
  const declared = nonEmptyMetadataString(metadata, 'modelTaskType');
  if (declared && QUEUE_MODEL_TASK_TYPES.has(declared as CatalogTaskType)) {
    return declared as CatalogTaskType;
  }
  const workflowStage = nonEmptyMetadataString(metadata, 'workflowStage');
  if (workflowStage === 'design') return 'design';
  if (workflowStage === 'review') return 'review';
  if (workflowStage === 'verification') return 'verify';
  if (workflowStage === 'discussion') return 'general';
  if (workflowStage === 'implementation') return 'code';
  return undefined;
}

function queueModelSelection(metadata: Record<string, unknown>): QueueModelSelection | undefined {
  const raw = nonEmptyMetadataString(metadata, 'modelSelection');
  if (!raw) return undefined;
  if (raw === 'explicit') return 'explicit';
  if (raw === 'task-type' || raw === 'automatic' || raw === 'auto') return 'task-type';
  if (raw === 'provider-default' || raw === 'default') return 'provider-default';
  return undefined;
}

function queueModelWorkload(metadata: Record<string, unknown>): ModelWorkloadTier {
  const declared = nonEmptyMetadataString(metadata, 'modelWorkload');
  return declared && QUEUE_MODEL_WORKLOADS.has(declared as ModelWorkloadTier)
    ? declared as ModelWorkloadTier
    : 'balanced';
}

/**
 * Resolve one durable task model against the provider that will actually run it.
 *
 * `task-type` selections are intentionally recomputed after every provider route
 * change. Explicit/legacy fixed models retain the caller's original token and
 * fail closed when the target provider catalog does not support it.
 */
export function resolveQueuedTaskModelForProvider(
  task: Pick<QueuedTask, 'model' | 'metadata'>,
  provider: ProviderConfig,
  durableMetadata: Record<string, unknown> = {},
): QueuedTaskModelResolution {
  const metadata = { ...(task.metadata ?? {}), ...durableMetadata };
  const declaredSelection = nonEmptyMetadataString(metadata, 'modelSelection');
  const normalizedSelection = queueModelSelection(metadata);
  if (declaredSelection && !normalizedSelection) {
    throw new QueueModelResolutionError(
      provider.id,
      `invalid modelSelection '${declaredSelection}'`,
    );
  }

  const persistedRequestedModel = nonEmptyMetadataString(metadata, 'requestedModel');
  const persistedModel = nonEmptyMetadataString(metadata, 'model');
  const taskModel = typeof task.model === 'string' && task.model.trim()
    ? task.model.trim()
    : undefined;
  const taskType = queueModelTaskType(metadata);
  const workload = queueModelWorkload(metadata);

  // Backward-compatible safety rule: a model persisted before provenance was
  // introduced is indistinguishable from a caller-fixed model. Treat it as
  // explicit so failover can never silently substitute another provider model.
  const selection: QueueModelSelection = normalizedSelection
    ?? (persistedRequestedModel || persistedModel || taskModel
      ? 'explicit'
      : taskType
        ? 'task-type'
        : 'provider-default');

  try {
    if (selection === 'explicit') {
      const requestedModel = persistedRequestedModel ?? persistedModel ?? taskModel;
      if (!requestedModel) {
        throw new QueueModelResolutionError(provider.id, 'explicit model provenance is missing');
      }
      const model = resolveProviderModel(provider, requestedModel) ?? undefined;
      return {
        model,
        executorModel: model,
        selection,
        requestedModel,
        metadataPatch: {
          modelSelection: selection,
          requestedModel,
          model: model ?? null,
          modelResolvedProvider: provider.id,
        },
      };
    }

    if (selection === 'task-type') {
      if (!taskType) {
        throw new QueueModelResolutionError(provider.id, 'task-type model provenance is missing');
      }
      const model = resolveProviderModelForTaskType(
        provider,
        taskType,
        undefined,
        workload,
      ) ?? undefined;
      return {
        model,
        executorModel: resolveProviderModelOverrideForTaskType(
          provider,
          taskType,
          undefined,
          workload,
        ) ?? undefined,
        selection,
        taskType,
        metadataPatch: {
          modelSelection: selection,
          modelTaskType: taskType,
          modelWorkload: workload,
          model: model ?? null,
          modelResolvedProvider: provider.id,
        },
      };
    }

    const model = resolveProviderModel(provider) ?? undefined;
    return {
      model,
      executorModel: undefined,
      selection,
      metadataPatch: {
        modelSelection: selection,
        model: model ?? null,
        modelResolvedProvider: provider.id,
      },
    };
  } catch (error) {
    if (error instanceof QueueModelResolutionError) throw error;
    throw new QueueModelResolutionError(
      provider.id,
      error instanceof Error ? error.message : String(error),
      persistedRequestedModel ?? persistedModel ?? taskModel,
    );
  }
}

export interface QueueMetrics {
  agentId: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  concurrency: number;
  mode: 'bullmq' | 'semaphore';
}

export const QUEUE_HYGIENE_DEFAULT_MAX_JOBS_PER_QUEUE = 200;
export const QUEUE_HYGIENE_MAX_JOBS_PER_QUEUE = 1_000;

export interface QueueHygieneQueueResult {
  agentId: string;
  queue: string;
  examined: number;
  candidates: number;
  removed: number;
  skippedActive: number;
  skippedUnplanned: number;
  errors: number;
  truncated: boolean;
  /** True when this queue no longer belongs to the committed provider catalog. */
  retired?: boolean;
  /** Explicit marker written by NCO for queues created by current code. */
  ownerMarker?: boolean;
  /** Jobs ignored because a historical unmarked queue lacked NCO payload evidence. */
  skippedUnowned?: number;
  candidateJobs: Array<{
    key: string;
    jobId: string;
    taskId: string | null;
    state: string;
  }>;
}

export interface QueueHygieneResult {
  mode: 'dry-run' | 'apply';
  namespace: string;
  isolatedNamespace: boolean;
  examined: number;
  candidates: number;
  removed: number;
  skippedActive: number;
  skippedUnplanned: number;
  errors: number;
  truncated: boolean;
  retiredQueues?: number;
  skippedUnowned?: number;
  discovery?: RetiredBullMqQueueDiscovery;
  queues: QueueHygieneQueueResult[];
}

export interface QueueHygieneCandidateIdentity {
  queue: string;
  agentId: string;
  jobId: string;
  taskId: string | null;
  state: string;
}

/** Stable compare-and-apply key shared by dry-run previews and apply passes. */
export function createQueueHygieneCandidateKey(
  candidate: QueueHygieneCandidateIdentity,
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      candidate.queue,
      candidate.agentId,
      candidate.jobId,
      candidate.taskId,
      candidate.state,
    ]))
    .digest('hex');
}

type BullQueueLiveCountReader = Pick<
  Queue<QueuedTask>,
  'getWaitingCount' | 'getPrioritizedCount' | 'getActiveCount'
>;

type BullQueueWaitingJobReader = Pick<
  Queue<QueuedTask>,
  'getWaiting' | 'getPrioritized'
>;

type BullPriorityAgingJob = Pick<
  Job<QueuedTask>,
  'timestamp' | 'priority' | 'opts' | 'changePriority'
>;

export const PRIORITY_AGING_MAX_JOBS_PER_TICK = 100;
export const PRIORITY_AGING_CLOSE_WAIT_MS = 1_000;

/**
 * BullMQ stores every job with a positive priority in the `prioritized` ZSET,
 * not in the ordinary `wait` list. NCO assigns priority 5 by default, so a
 * waiting-only snapshot reports an empty queue even while work is backlogged.
 */
export async function readBullQueueLiveCounts(
  queue: BullQueueLiveCountReader,
): Promise<{ waiting: number; active: number }> {
  const [waiting, prioritized, active] = await Promise.all([
    queue.getWaitingCount(),
    queue.getPrioritizedCount(),
    queue.getActiveCount(),
  ]);
  return { waiting: waiting + prioritized, active };
}

/** Return every runnable waiting job, regardless of BullMQ storage class. */
export async function listBullQueueWaitingJobs(queue: BullQueueWaitingJobReader) {
  const [waiting, prioritized] = await Promise.all([
    queue.getWaiting(),
    queue.getPrioritized(),
  ]);
  return [...waiting, ...prioritized];
}

/** Age a bounded number of old jobs using BullMQ's live priority value. */
export async function ageBullQueueWaitingJobs(
  jobs: readonly BullPriorityAgingJob[],
  now = Date.now(),
  maxJobs = PRIORITY_AGING_MAX_JOBS_PER_TICK,
): Promise<number> {
  let changed = 0;
  let inspected = 0;
  for (const job of jobs) {
    if (inspected >= maxJobs) break;
    inspected += 1;
    if (now - job.timestamp <= 300_000) continue;

    const currentPriority = job.priority ?? job.opts.priority ?? 5;
    if (currentPriority <= 0) continue;
    await job.changePriority({ priority: currentPriority - 1 });
    changed += 1;
  }
  return changed;
}

export function resolveVerifierProjectDir(task: Pick<QueuedTask, 'metadata'>): string {
  const requested = typeof task.metadata?.projectDir === 'string'
    ? task.metadata.projectDir.trim()
    : '';
  return requested || env.PROJECT_DIR;
}

/**
 * Persist the worker start before execution.
 *
 * Startup recovery deliberately puts orphaned work back in `queued`. Without
 * this transition, a successful recovered worker later attempts
 * `queued -> completed`, which the task state machine correctly rejects.
 */
export type TaskExecutionStartResult = {
  ok: boolean;
  prev?: string;
  reason?:
    | 'duplicate_attempt'
    | 'stale_attempt'
    | 'future_attempt'
    | 'route_mismatch'
    | 'ownership_unknown'
    | 'ownership_expired'
    | 'invalid_transition';
};

/**
 * Atomically fence provider execution by the durable (task, queue-attempt) pair.
 *
 * BullMQ job ids are unique only inside one provider queue. The metadata claim is
 * stored in SQLite under BEGIN IMMEDIATE, so jobs for the same logical attempt
 * that reached different provider queues still have exactly one execution owner.
 */
export function markTaskExecutionStarted(
  taskId: string,
  rawAttempt: unknown = 0,
  agentId?: string,
): TaskExecutionStartResult {
  const db = getDb();
  const attempt = normalizeQueueAttempt(rawAttempt);
  const result = db.transaction((): TaskExecutionStartResult => {
    const ownershipEnabled = taskQueueOwnershipColumnsAvailable(db);
    const executorColumn = taskQueueExecutorColumnAvailable(db);
    const row = db.prepare(`
      SELECT status, assigned_to, metadata_json
             ${ownershipEnabled ? ', queue_owner_instance_id, queue_owner_epoch, queue_expires_at' : ''}
      FROM tasks
      WHERE id=?
    `).get(taskId) as {
      status: string;
      assigned_to: string | null;
      metadata_json: string | null;
      queue_owner_instance_id?: string | null;
      queue_owner_epoch?: number | null;
      queue_expires_at?: string | null;
    } | undefined;
    if (!row) return { ok: false };
    if (TERMINAL_STATES.has(row.status)) return { ok: false, prev: row.status };

    const metadata = parseTaskMetadataJson(row.metadata_json);
    const scheduledAttempt = readQueueAttempt(metadata.ncoQueueAttempt) ?? attempt;
    const scheduledAgent = typeof metadata.ncoQueueAttemptAgentId === 'string'
      ? metadata.ncoQueueAttemptAgentId
      : undefined;
    const claimedAttempt = readQueueAttempt(metadata.ncoQueueAttemptClaimed);
    const finishedAttempt = readQueueAttempt(metadata.ncoQueueAttemptFinished);

    if (attempt < scheduledAttempt) {
      return { ok: false, prev: row.status, reason: 'stale_attempt' };
    }
    if (attempt > scheduledAttempt) {
      return { ok: false, prev: row.status, reason: 'future_attempt' };
    }
    if (
      !agentId
      || !scheduledAgent
      || scheduledAgent !== agentId
      || row.assigned_to !== agentId
    ) {
      return { ok: false, prev: row.status, reason: 'route_mismatch' };
    }
    if (ownershipEnabled) {
      const ownerKnown = queueOwnershipMatches({
        ownerInstanceId: row.queue_owner_instance_id,
        ownerEpoch: row.queue_owner_epoch,
        queueExpiresAt: row.queue_expires_at,
        metadata,
        attempt,
      });
      if (!ownerKnown) {
        const expiresAtMs = row.queue_expires_at
          ? Date.parse(`${row.queue_expires_at.replace(' ', 'T')}Z`)
          : Number.NaN;
        return {
          ok: false,
          prev: row.status,
          reason: Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()
            ? 'ownership_expired'
            : 'ownership_unknown',
        };
      }
    }
    if (claimedAttempt !== null && claimedAttempt > attempt) {
      return { ok: false, prev: row.status, reason: 'stale_attempt' };
    }
    if (claimedAttempt === attempt) {
      return { ok: false, prev: row.status, reason: 'duplicate_attempt' };
    }
    if (row.status === 'running' || row.status === 'streaming' || row.status === 'in_progress') {
      if (
        claimedAttempt === null
        || attempt !== claimedAttempt + 1
        || finishedAttempt !== claimedAttempt
      ) {
        return { ok: false, prev: row.status, reason: 'invalid_transition' };
      }
    }

    let executionStatus = row.status;
    if (executionStatus === 'pending' || executionStatus === 'queued') {
      const assigned = transitionTask(db, taskId, 'assigned');
      if (!assigned.ok) {
        return { ok: false, prev: assigned.prev, reason: 'invalid_transition' };
      }
      executionStatus = 'assigned';
    }
    if (executionStatus === 'assigned') {
      // ACK is intentionally assigned-only. It must happen before the running
      // transition or acknowledgeTaskLease() observes running and rejects it.
      const acknowledged = acknowledgeTaskLease(taskId);
      if (!acknowledged.ok) {
        return { ok: false, prev: acknowledged.status ?? undefined, reason: 'invalid_transition' };
      }
    }

    if (executionStatus !== 'running') {
      const moved = transitionTask(db, taskId, 'running');
      if (!moved.ok) {
        // `streaming` and the legacy `in_progress` state are valid sources for a
        // new generation even though the generic state table does not model a
        // backwards transition to running.
        if (executionStatus !== 'streaming' && executionStatus !== 'in_progress') {
          return { ok: false, prev: moved.prev, reason: 'invalid_transition' };
        }
        db.prepare(`
          UPDATE tasks
          SET status='running', updated_at=datetime('now')
          WHERE id=? AND status=?
        `).run(taskId, executionStatus);
      }
    }

    metadata.ncoQueueAttemptClaimed = attempt;
    heartbeatTaskQueueInstance(db);
    db.prepare(`
      UPDATE tasks
      SET metadata_json=?
          ${ownershipEnabled ? ', queue_expires_at=?' : ''}
          ${executorColumn ? ', queue_executor_instance_id=?' : ''},
          updated_at=datetime('now')
      WHERE id=?
    `).run(
      JSON.stringify(metadata),
      ...(ownershipEnabled
        ? [sqliteUtcAfter(Date.now(), resolveQueueOwnershipLeaseMs())]
        : []),
      ...(executorColumn ? [TASK_QUEUE_OWNER_INSTANCE_ID] : []),
      taskId,
    );
    return { ok: true, prev: row.status };
  }).immediate();

  return result;
}

/** Record that the exact claimed generation has stopped executing. */
export function markTaskExecutionFinished(
  taskId: string,
  rawAttempt: unknown,
  agentId: string,
): boolean {
  const db = getDb();
  const attempt = normalizeQueueAttempt(rawAttempt);
  return db.transaction(() => {
    const executorColumn = taskQueueExecutorColumnAvailable(db);
    const row = db.prepare(`
      SELECT status, assigned_to, metadata_json
      FROM tasks
      WHERE id=?
    `).get(taskId) as {
      status: string;
      assigned_to: string | null;
      metadata_json: string | null;
    } | undefined;
    if (!row || TERMINAL_STATES.has(row.status)) return false;

    const metadata = parseTaskMetadataJson(row.metadata_json);
    if (
      readQueueAttempt(metadata.ncoQueueAttempt) !== attempt
      || readQueueAttempt(metadata.ncoQueueAttemptClaimed) !== attempt
      || metadata.ncoQueueAttemptAgentId !== agentId
      || row.assigned_to !== agentId
    ) return false;

    metadata.ncoQueueAttemptFinished = attempt;
    const updated = db.prepare(`
      UPDATE tasks
      SET metadata_json=?
          ${executorColumn ? ', queue_executor_instance_id=NULL' : ''},
          updated_at=datetime('now')
      WHERE id=? AND status=? AND assigned_to=?
        ${executorColumn ? 'AND queue_executor_instance_id=?' : ''}
    `).run(
      JSON.stringify(metadata),
      taskId,
      row.status,
      agentId,
      ...(executorColumn ? [TASK_QUEUE_OWNER_INSTANCE_ID] : []),
    );
    return updated.changes === 1;
  }).immediate();
}

export type TaskExecutionResult = {
  success: boolean;
  output: string;
  error?: string;
  /**
   * A queue coordination result is deliberately non-terminal. `joined` means
   * another worker owns the same attempt; `deduplicated` means this stale or
   * conflicting caller must observe durable state instead of rewriting it.
   */
  queueOutcome?: 'joined' | 'deduplicated';
  status?: 'completed' | 'failed' | 'timed_out' | 'cancelled';
  evidenceJson?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};
type TaskExecutor = (task: QueuedTask, signal: AbortSignal) => Promise<TaskExecutionResult>;

export const GRACEFUL_SHUTDOWN_INTERRUPTION = 'orphaned: graceful shutdown signal';
const PROCESS_INTERRUPT_PATTERN = /SIGINT|exit(?: code)?=130|exit 130|aborting operation/i;

/**
 * PM2 sends SIGINT to the NCO process group during a restart, so active provider
 * CLIs can report exit 130 or a generic exit 1 before the shutdown drain observes
 * them. The runtime marker covers only tasks that were active when shutdown began;
 * the error pattern fallback preserves the legacy process-signal detection.
 */
export function normalizeGracefulShutdownInterruption(
  result: TaskExecutionResult,
  shutdownSignal: string | null,
  wasRunningAtShutdown = false,
): TaskExecutionResult {
  if (
    !shutdownSignal
    || result.success
    || (!wasRunningAtShutdown && !PROCESS_INTERRUPT_PATTERN.test(result.error ?? ''))
  ) {
    return result;
  }

  return {
    ...result,
    success: false,
    status: 'cancelled',
    error: `${GRACEFUL_SHUTDOWN_INTERRUPTION} (${shutdownSignal})`,
  };
}

/**
 * Persist the terminal result of a task re-enqueued during startup recovery.
 *
 * Normal API tasks are terminalized by the gateway caller after enqueue()
 * resolves. Startup recovery has no gateway request waiting on the promise, so
 * it must explicitly persist the result or the task remains `running` and is
 * treated as another orphan on the next restart.
 */
export function persistRecoveredTaskResult(
  db: Database.Database,
  taskId: string,
  result: TaskExecutionResult,
): { ok: boolean; prev?: string } {
  if (isTaskExecutionJoinOutcome(result)) {
    const row = db.prepare('SELECT status FROM tasks WHERE id=?')
      .get(taskId) as { status?: string } | undefined;
    return { ok: false, prev: row?.status };
  }
  let nextStatus = result.status === 'cancelled'
    ? 'cancelled'
    : result.status === 'timed_out'
        || result.error === 'timeout(idle)'
        || result.error === 'timeout(hardcap)'
      ? 'timed_out'
      : result.success
        ? 'completed'
        : 'failed';
  if (nextStatus === 'completed') {
    const row = db.prepare(`
      SELECT team_id, metadata_json
      FROM tasks
      WHERE id=?
    `).get(taskId) as {
      team_id: string | null;
      metadata_json: string | null;
    } | undefined;
    let metadata: Record<string, unknown> = {};
    try {
      metadata = row?.metadata_json
        ? JSON.parse(row.metadata_json) as Record<string, unknown>
        : {};
    } catch {
      metadata = {};
    }
    const auditControlPlane = metadata.auditControlPlane === true
      || typeof metadata.verificationDirectiveId === 'string';
    if (row?.team_id && !auditControlPlane) nextStatus = 'reviewing';
  }
  const error = nextStatus === 'completed' || nextStatus === 'reviewing'
    ? undefined
    : result.error || 'unknown: execution failed';

  return transitionTask(db, taskId, nextStatus, {
    response: result.output || undefined,
    error,
    completedAt: nextStatus !== 'cancelled' && nextStatus !== 'reviewing',
    evidenceJson:
      nextStatus === 'completed' || nextStatus === 'reviewing'
        ? result.evidenceJson
        : undefined,
  });
}

export type VerifierResult = {
  type: 'run';
  command: string;
  timeoutMs: number;
  startedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  passed: boolean;
  outputSnippet: string;
  spawnError?: string;
  verifier_skipped?: 'pre-existing build failure';
  baseline_indeterminate?: 'HEAD-clean verifier baseline unavailable or inconclusive';
};

export type VerifierProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export function shouldPurgeStaleJob(status: string | undefined): boolean {
  return status === undefined || TERMINAL_STATES.has(status);
}

/** Active locks are never hygiene-owned; BullMQ's stalled-job flow owns them. */
export function shouldPurgeStartupActiveJob(_status: string | undefined): boolean {
  return false;
}

type QueueHygieneAdapter = Pick<Queue<QueuedTask>, 'name' | 'getJobs'>;

/**
 * Historical queues predate the explicit owner marker. Their individual jobs
 * are cleanup-owned only when the payload still proves the exact NCO provider
 * route. This prevents a similarly named foreign BullMQ queue from becoming a
 * mutation target merely because it shares the default `bull` namespace.
 */
export function isNcoOwnedBullMqJobData(data: unknown, agentId: string): boolean {
  if (!data || typeof data !== 'object') return false;
  const candidate = data as Partial<QueuedTask>;
  return typeof candidate.taskId === 'string'
    && candidate.taskId.trim().length > 0
    && candidate.agentId === agentId
    && typeof candidate.prompt === 'string';
}

/**
 * Bounded BullMQ hygiene pass. Cleanup never deletes an active job or its lock:
 * another live or draining worker may own it. BullMQ stalled-job recovery is
 * the sole authority for reclaiming active jobs, including during startup.
 */
export async function inspectBullQueueStaleJobs(
  queue: QueueHygieneAdapter,
  readTaskStatus: (taskId: string) => string | undefined,
  options: {
    agentId: string;
    mode?: 'dry-run' | 'apply';
    startup?: boolean;
    maxJobs?: number;
    plannedCandidateKeys?: ReadonlySet<string>;
    canMutate?: () => boolean;
    retired?: boolean;
    ownerMarker?: boolean;
  },
): Promise<QueueHygieneQueueResult> {
  const mode = options.mode ?? 'dry-run';
  const maxJobs = Math.min(
    QUEUE_HYGIENE_MAX_JOBS_PER_QUEUE,
    Math.max(1, Math.trunc(options.maxJobs ?? QUEUE_HYGIENE_DEFAULT_MAX_JOBS_PER_QUEUE)),
  );
  const states: JobType[] = ['wait', 'delayed', 'prioritized', 'paused', 'active', 'completed', 'failed'];
  const jobs = (await queue.getJobs(states, 0, maxJobs - 1, true))
    .filter((job): job is Job<QueuedTask> => job != null);
  const result: QueueHygieneQueueResult = {
    agentId: options.agentId,
    queue: queue.name,
    examined: jobs.length,
    candidates: 0,
    removed: 0,
    skippedActive: 0,
    skippedUnplanned: 0,
    errors: 0,
    truncated: jobs.length >= maxJobs,
    retired: options.retired === true,
    ownerMarker: options.ownerMarker === true,
    skippedUnowned: 0,
    candidateJobs: [],
  };

  for (const job of jobs) {
    if (
      options.retired
      && !options.ownerMarker
      && !isNcoOwnedBullMqJobData(job.data, options.agentId)
    ) {
      result.skippedUnowned = (result.skippedUnowned ?? 0) + 1;
      continue;
    }
    const taskId = job.data?.taskId;
    const status = typeof taskId === 'string' ? readTaskStatus(taskId) : undefined;
    let state: string;
    try {
      state = await job.getState();
    } catch {
      result.errors += 1;
      continue;
    }
    const active = state === 'active';
    if (active) {
      // Active ownership belongs exclusively to BullMQ stalled recovery. Count
      // terminal/missing DB records as protected skips so status explains why
      // a seemingly stale job was intentionally left untouched.
      if (shouldPurgeStaleJob(status)) result.skippedActive += 1;
      continue;
    }
    const stale = shouldPurgeStaleJob(status);
    if (!stale) continue;
    const jobId = String(job.id ?? '');
    const normalizedTaskId = typeof taskId === 'string' ? taskId : null;
    const key = createQueueHygieneCandidateKey({
      queue: queue.name,
      agentId: options.agentId,
      jobId,
      taskId: normalizedTaskId,
      state,
    });
    result.candidates += 1;
    result.candidateJobs.push({
      key,
      jobId,
      taskId: normalizedTaskId,
      state,
    });

    if (mode !== 'apply') continue;
    if (!options.plannedCandidateKeys?.has(key)) {
      result.skippedUnplanned += 1;
      continue;
    }
    try {
      if (options.canMutate && !options.canMutate()) {
        throw new Error('queue hygiene mutation lease lost');
      }
      await job.remove();
      result.removed += 1;
    } catch (error) {
      if (error instanceof Error && error.message === 'queue hygiene mutation lease lost') {
        throw error;
      }
      // A worker may move the job after the snapshot. Preserve it for the next
      // pass instead of deleting broader Redis keys.
      result.errors += 1;
    }
  }
  return result;
}

/**
 * BullMQ state is shared by every process connected to Redis. A test or secondary
 * NCO instance that uses a different SQLite database must therefore never inspect
 * or purge the production queue namespace. Keep the historical `bull` prefix for
 * the canonical database, and derive a stable opaque prefix for every other DB.
 */
export function resolveBullMqPrefix(
  databasePath = env.DATABASE_PATH,
  override = process.env.NCO_BULLMQ_PREFIX,
): string {
  const requested = override?.trim();
  if (requested) {
    if (!/^[A-Za-z0-9_-]+$/.test(requested)) {
      throw new Error('NCO_BULLMQ_PREFIX may contain only letters, numbers, _ and -');
    }
    return requested;
  }

  const absoluteDatabasePath = resolve(databasePath);
  const defaultDatabasePath = resolve(
    typeof env.ROOT === 'string' && env.ROOT ? env.ROOT : process.cwd(),
    'db/nco.db',
  );
  if (absoluteDatabasePath === defaultDatabasePath) return 'bull';
  const databaseId = createHash('sha256')
    .update(absoluteDatabasePath)
    .digest('hex')
    .slice(0, 16);
  return `bull-nco-${databaseId}`;
}

/**
 * One durable task can make several bounded provider attempts. Every process
 * must derive the same BullMQ ID for the same logical attempt so Queue.add()
 * provides cross-process single-flight without recycling a completed job.
 */
export function resolveBullMqJobId(taskId: string, rawAttempt: unknown): string {
  const attempt = normalizeQueueAttempt(rawAttempt);
  return `${taskId}--nco-a${attempt}`;
}

export type BestEffortSqliteWriteResult =
  | { ok: true }
  | { ok: false; retryable: boolean; error: unknown };

/** 활동/하트비트 같은 보조 기록 실패가 provider 스트림과 백엔드를 종료시키지 않게 한다. */
export function runBestEffortSqliteWrite(write: () => void): BestEffortSqliteWriteResult {
  try {
    write();
    return { ok: true };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      retryable: code === 'SQLITE_BUSY'
        || code === 'SQLITE_LOCKED'
        || /database is (?:locked|busy)/i.test(message),
      error,
    };
  }
}

export const TASK_EXECUTION_FINISH_MAX_ATTEMPTS = 3;
export const TASK_EXECUTION_FINISH_RETRY_BASE_MS = 25;

export class DurableQueueAttemptCleanupError extends Error {
  readonly code = 'NCO_QUEUE_ATTEMPT_CLEANUP_FAILED';
  readonly attempts: number;
  readonly originalError: unknown;

  constructor(taskId: string, queueAttempt: number, attempts: number, originalError: unknown) {
    super(
      `durable queue attempt cleanup failed after ${attempts} attempts: `
      + `task ${taskId} generation ${queueAttempt}`,
    );
    this.name = 'DurableQueueAttemptCleanupError';
    this.attempts = attempts;
    this.originalError = originalError;
  }
}

export interface TaskExecutionFinishRetryOptions {
  maxAttempts?: number;
  retryBaseMs?: number;
  markFinished?: typeof markTaskExecutionFinished;
  sleep?: (delayMs: number) => Promise<void>;
}

/**
 * Release one durable execution generation with bounded lock retries.
 *
 * A better-sqlite3 write already obeys the connection busy_timeout, so this
 * helper deliberately caps both the retry count and the backoff. If the lock
 * outlives that budget, the caller receives a typed error and must stop the
 * immediate retry chain; the existing lease sweeper/startup orphan recovery can
 * then reclaim the running task without dispatching generation N+1 over an
 * un-finished generation N.
 */
export async function finishTaskExecutionWithRetry(
  taskId: string,
  rawAttempt: unknown,
  agentId: string,
  options: TaskExecutionFinishRetryOptions = {},
): Promise<boolean> {
  const queueAttempt = normalizeQueueAttempt(rawAttempt);
  const requestedAttempts = Number(options.maxAttempts ?? TASK_EXECUTION_FINISH_MAX_ATTEMPTS);
  const maxAttempts = Number.isFinite(requestedAttempts)
    ? Math.max(1, Math.min(10, Math.trunc(requestedAttempts)))
    : TASK_EXECUTION_FINISH_MAX_ATTEMPTS;
  const requestedBaseMs = Number(options.retryBaseMs ?? TASK_EXECUTION_FINISH_RETRY_BASE_MS);
  const retryBaseMs = Number.isFinite(requestedBaseMs)
    ? Math.max(0, Math.min(1_000, Math.trunc(requestedBaseMs)))
    : TASK_EXECUTION_FINISH_RETRY_BASE_MS;
  const markFinished = options.markFinished ?? markTaskExecutionFinished;
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>(resolve => {
    setTimeout(resolve, delayMs);
  }));

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let marked = false;
    const write = runBestEffortSqliteWrite(() => {
      marked = markFinished(taskId, queueAttempt, agentId);
    });
    if (write.ok) return marked;
    lastError = write.error;
    if (!write.retryable) throw write.error;
    if (attempt < maxAttempts) {
      await sleep(retryBaseMs * 2 ** (attempt - 1));
    }
  }

  throw new DurableQueueAttemptCleanupError(
    taskId,
    queueAttempt,
    maxAttempts,
    lastError,
  );
}

/**
 * verifier 실패를 HEAD 대조로 넘길지 판정한다.
 *
 * **baseline 부재(null)는 "깨끗했다"가 아니라 "모른다"이다.** 초판 호출부가
 * `if (preTaskBaseline && ...)` 로 시작해 null 이면 대조를 통째로 건너뛰었고, 그 결과
 * 기존에 깨져 있던 빌드가 정답을 실패로 뒤집었다(gentop 실측 2026-08-07: 응답 391 로
 * 정확한 태스크가 무관한 tsc 오류 3건 때문에 failed).
 */
export function shouldReconcileVerifierBaseline(
  preTaskBaseline: Pick<VerifierProcessResult, 'code' | 'timedOut'> | null,
): boolean {
  if (!preTaskBaseline) return true;
  return preTaskBaseline.code !== 0 || preTaskBaseline.timedOut;
}

/**
 * 대조에 넘길 baseline 을 만든다. 못 잡았으면 `code: null` 로 넘겨
 * `reconcileVerifierBaseline` 의 "깨끗함" 조건을 통과하지 못하게 한다.
 */
export function baselineForReconciliation(
  preTaskBaseline: Pick<VerifierProcessResult, 'code' | 'timedOut'> | null,
): Pick<VerifierProcessResult, 'code' | 'timedOut'> {
  return preTaskBaseline ?? { code: null, timedOut: false };
}

export function reconcileVerifierBaseline(
  verifierResult: VerifierResult,
  baseline: Pick<VerifierProcessResult, 'code' | 'timedOut'>,
  headBaseline: Pick<VerifierProcessResult, 'code' | 'timedOut'> | null = null,
): VerifierResult {
  if (baseline.code === 0 && !baseline.timedOut) return verifierResult;
  if (
    !headBaseline
    || headBaseline.code == null
    || headBaseline.timedOut
  ) {
    return {
      ...verifierResult,
      passed: false,
      baseline_indeterminate: 'HEAD-clean verifier baseline unavailable or inconclusive',
    };
  }
  if (headBaseline.code === 0) return verifierResult;
  return {
    ...verifierResult,
    passed: true,
    verifier_skipped: 'pre-existing build failure',
  };
}

export function terminalDuplicateExecutionError(
  taskId: string,
  status: string | undefined,
): UnrecoverableError | null {
  if (status === undefined) {
    return new UnrecoverableError(
      `duplicate_execution: task ${taskId} has no durable task row`,
    );
  }
  if (!TERMINAL_STATES.has(status)) return null;
  return new UnrecoverableError(
    `duplicate_execution: task ${taskId} already terminal (${status})`,
  );
}

export function queueAttemptDuplicateExecutionError(
  taskId: string,
  attempt: number,
  reason: NonNullable<TaskExecutionStartResult['reason']>,
): UnrecoverableError {
  return new UnrecoverableError(
    `duplicate_execution: task ${taskId} attempt ${attempt} rejected (${reason})`,
  );
}

export function isDuplicateExecutionFailure(
  result: Pick<TaskExecutionResult, 'success' | 'error'>,
): boolean {
  return !result.success && (result.error ?? '').startsWith('duplicate_execution:');
}

export function isTaskExecutionJoinOutcome(
  result: Pick<TaskExecutionResult, 'queueOutcome'>,
): boolean {
  return result.queueOutcome === 'joined' || result.queueOutcome === 'deduplicated';
}

export function duplicateExecutionResultFromError(
  error: unknown,
): TaskExecutionResult | null {
  const message = error instanceof Error ? error.message : String(error);
  const result: TaskExecutionResult = {
    success: false,
    output: '',
    error: message,
    queueOutcome: /\(duplicate_attempt\)/.test(message) ? 'joined' : 'deduplicated',
  };
  return isDuplicateExecutionFailure(result) ? result : null;
}

function parseTaskMetadataJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function taskQueueOwnershipColumnsAvailable(db: Database.Database): boolean {
  const columns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name?: string }>;
  const names = new Set(columns.map(column => column.name));
  return names.has('recovery_policy')
    && names.has('queue_owner_instance_id')
    && names.has('queue_owner_epoch')
    && names.has('queue_expires_at');
}

function taskQueueExecutorColumnAvailable(db: Database.Database): boolean {
  const columns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name?: string }>;
  return columns.some(column => column.name === 'queue_executor_instance_id');
}

export function isQueueOwnershipLeaseActive(
  queueExpiresAt: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!queueExpiresAt) return false;
  const parsed = Date.parse(`${queueExpiresAt.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) && parsed > nowMs;
}

function sqliteUtcAfter(nowMs: number, durationMs: number): string {
  return new Date(nowMs + durationMs).toISOString().replace('T', ' ').slice(0, 19);
}

function readQueueOwnerEpoch(raw: unknown): number | null {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function queueOwnershipMatches(input: {
  ownerInstanceId: string | null | undefined;
  ownerEpoch: number | null | undefined;
  queueExpiresAt: string | null | undefined;
  metadata: Record<string, unknown>;
  attempt: number;
  nowMs?: number;
}): boolean {
  const metadataOwner = typeof input.metadata.ncoQueueOwnerInstanceId === 'string'
    ? input.metadata.ncoQueueOwnerInstanceId
    : '';
  const metadataEpoch = readQueueOwnerEpoch(input.metadata.ncoQueueOwnerEpoch);
  const expiresAtMs = input.queueExpiresAt
    ? Date.parse(`${input.queueExpiresAt.replace(' ', 'T')}Z`)
    : Number.NaN;
  return Boolean(input.ownerInstanceId)
    && input.ownerInstanceId === metadataOwner
    && readQueueOwnerEpoch(input.ownerEpoch) === metadataEpoch
    && readQueueAttempt(input.metadata.ncoQueueOwnerAttempt) === input.attempt
    && Number.isFinite(expiresAtMs)
    && expiresAtMs > (input.nowMs ?? Date.now());
}

function readQueueAttempt(rawAttempt: unknown): number | null {
  const parsed = Number(rawAttempt);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function normalizeQueueAttempt(rawAttempt: unknown): number {
  return readQueueAttempt(rawAttempt) ?? 0;
}

function loadTaskMetadata(taskId: string): Record<string, unknown> {
  const row = getDb().prepare('SELECT metadata_json FROM tasks WHERE id=?').get(taskId) as { metadata_json: string | null } | undefined;
  return parseTaskMetadataJson(row?.metadata_json);
}

export interface StartupRecoveryClaimInput {
  taskId: string;
  status: string;
  recoveryCount: number;
  metadataJson: string | null;
  ownerInstanceId: string | null;
  ownerEpoch: number | null;
  queueExpiresAt: string | null;
  executorInstanceId?: string | null;
}

export interface StartupRecoveryClaimResult {
  claimed: boolean;
  metadataJson: string | null;
  queueAttempt: number;
  ownerEpoch: number;
  queueExpiresAt: string;
}

/**
 * Claim one startup recovery generation with an exact stale-snapshot CAS.
 * queued→queued does not change status, so status alone is never a sufficient
 * compare key; owner, epoch, expiry, executor and recovery budget all fence it.
 */
export function claimTaskForStartupRecovery(
  database: Database.Database,
  input: StartupRecoveryClaimInput,
  options: {
    ownerInstanceId?: string;
    nowMs?: number;
    leaseMs?: number;
  } = {},
): StartupRecoveryClaimResult {
  const ownerInstanceId = options.ownerInstanceId ?? TASK_QUEUE_OWNER_INSTANCE_ID;
  const nowMs = options.nowMs ?? Date.now();
  const leaseMs = options.leaseMs ?? resolveQueueOwnershipLeaseMs();
  const metadata = parseTaskMetadataJson(input.metadataJson);
  const queueAttempt = normalizeQueueAttempt(metadata.ncoQueueAttempt) + 1;
  const ownerEpoch = Math.max(0, Number(input.ownerEpoch) || 0) + 1;
  const queueExpiresAt = sqliteUtcAfter(nowMs, leaseMs);
  metadata.ncoQueueAttempt = queueAttempt;
  delete metadata.ncoQueueAttemptAgentId;
  metadata.ncoQueueOwnerInstanceId = ownerInstanceId;
  metadata.ncoQueueOwnerEpoch = ownerEpoch;
  metadata.ncoQueueOwnerAttempt = queueAttempt;
  const metadataJson = JSON.stringify(metadata);
  const executorColumn = taskQueueExecutorColumnAvailable(database);
  const updated = database.prepare(`
    UPDATE tasks
    SET status='queued', orphan_requeue_count=orphan_requeue_count + 1,
        metadata_json=?, error=NULL, queue_owner_instance_id=?,
        queue_owner_epoch=?, queue_expires_at=?
        ${executorColumn ? ', queue_executor_instance_id=NULL' : ''},
        updated_at=datetime('now')
    WHERE id=? AND status=? AND recovery_policy='auto'
      AND orphan_requeue_count=?
      AND queue_owner_instance_id IS ?
      AND queue_owner_epoch=?
      AND queue_expires_at IS ?
      ${executorColumn ? 'AND queue_executor_instance_id IS ?' : ''}
  `).run(
    metadataJson,
    ownerInstanceId,
    ownerEpoch,
    queueExpiresAt,
    input.taskId,
    input.status,
    input.recoveryCount,
    input.ownerInstanceId,
    input.ownerEpoch ?? 0,
    input.queueExpiresAt,
    ...(executorColumn ? [input.executorInstanceId ?? null] : []),
  );
  return {
    claimed: updated.changes === 1,
    metadataJson,
    queueAttempt,
    ownerEpoch,
    queueExpiresAt,
  };
}

function renewTaskQueueOwnership(
  database: Database.Database,
  taskId: string,
  rawAttempt: unknown,
  nowMs = Date.now(),
): boolean {
  if (!taskQueueOwnershipColumnsAvailable(database)) return false;
  const attempt = normalizeQueueAttempt(rawAttempt);
  const metadata = loadTaskMetadata(taskId);
  const owner = typeof metadata.ncoQueueOwnerInstanceId === 'string'
    ? metadata.ncoQueueOwnerInstanceId
    : null;
  const epoch = readQueueOwnerEpoch(metadata.ncoQueueOwnerEpoch);
  if (!owner || epoch === null || readQueueAttempt(metadata.ncoQueueOwnerAttempt) !== attempt) {
    return false;
  }
  const updated = database.prepare(`
    UPDATE tasks
    SET queue_expires_at=?, updated_at=datetime('now')
    WHERE id=? AND queue_owner_instance_id=? AND queue_owner_epoch=?
      AND status NOT IN ('completed','failed','timed_out','cancelled','lease_expired')
  `).run(
    sqliteUtcAfter(nowMs, resolveQueueOwnershipLeaseMs()),
    taskId,
    owner,
    epoch,
  );
  return updated.changes === 1;
}

export interface PersistedQueueAttempt {
  attempt: number;
  agentId: string;
  metadata: Record<string, unknown>;
}

export interface QueueAttemptAdvanceExpectation {
  attempt: number;
  agentId: string;
  status: string;
}

export type QueueAttemptMetadataResolver = (
  agentId: string,
  metadata: Readonly<Record<string, unknown>>,
) => Record<string, unknown>;

/**
 * Select one durable provider route for a task generation before Queue.add().
 * The first scheduler for an attempt wins; all other processes read and use the
 * same provider queue, extending BullMQ's queue-local job-id dedupe task-wide.
 */
export function persistTaskQueueAttempt(
  taskId: string,
  rawAttempt: unknown,
  requestedAgentId: string,
  expectedPrevious?: QueueAttemptAdvanceExpectation,
  resolveMetadata?: QueueAttemptMetadataResolver,
): PersistedQueueAttempt {
  const db = getDb();
  heartbeatTaskQueueInstance(db);
  const requestedAttempt = normalizeQueueAttempt(rawAttempt);
  return db.transaction((): PersistedQueueAttempt => {
    const ownershipEnabled = taskQueueOwnershipColumnsAvailable(db);
    const row = db.prepare(`
      SELECT status, assigned_to, metadata_json, mode
             ${ownershipEnabled ? ', recovery_policy, queue_owner_instance_id, queue_owner_epoch, queue_expires_at' : ''}
      FROM tasks
      WHERE id=?
    `).get(taskId) as {
      status: string;
      assigned_to: string | null;
      metadata_json: string | null;
      mode: string | null;
      recovery_policy?: string | null;
      queue_owner_instance_id?: string | null;
      queue_owner_epoch?: number | null;
      queue_expires_at?: string | null;
    } | undefined;
    const terminal = terminalDuplicateExecutionError(taskId, row?.status);
    if (terminal) throw terminal;

    const metadata = parseTaskMetadataJson(row?.metadata_json);
    const currentAttempt = readQueueAttempt(metadata.ncoQueueAttempt);
    const claimedAttempt = readQueueAttempt(metadata.ncoQueueAttemptClaimed);
    const finishedAttempt = readQueueAttempt(metadata.ncoQueueAttemptFinished);
    const rawExistingAgent = typeof metadata.ncoQueueAttemptAgentId === 'string'
      && metadata.ncoQueueAttemptAgentId.length > 0
      ? metadata.ncoQueueAttemptAgentId
      : undefined;
    const existingAgent = typeof metadata.ncoQueueAttemptAgentId === 'string'
      && metadata.ncoQueueAttemptAgentId.length > 0
      && metadata.ncoQueueAttemptAgentId === row?.assigned_to
      ? metadata.ncoQueueAttemptAgentId
      : undefined;

    let attempt = requestedAttempt;
    let agentId = requestedAgentId;
    if (currentAttempt !== null && currentAttempt > requestedAttempt) {
      attempt = currentAttempt;
      if (!existingAgent) {
        throw queueAttemptDuplicateExecutionError(taskId, requestedAttempt, 'route_mismatch');
      }
      agentId = existingAgent;
    } else if (currentAttempt === requestedAttempt && existingAgent) {
      agentId = existingAgent;
    } else if (currentAttempt === requestedAttempt) {
      // A route may be initialized for an unclaimed generation (including an
      // interrupted N→N+1 recovery), but never repaired underneath its owner.
      if (
        rawExistingAgent
        || claimedAttempt === currentAttempt
        || row?.status === 'running'
        || row?.status === 'streaming'
        || row?.status === 'in_progress'
      ) {
        throw queueAttemptDuplicateExecutionError(taskId, requestedAttempt, 'route_mismatch');
      }
    } else if (currentAttempt !== null) {
      if (requestedAttempt !== currentAttempt + 1) {
        throw queueAttemptDuplicateExecutionError(taskId, requestedAttempt, 'future_attempt');
      }
      if (
        !expectedPrevious
        || expectedPrevious.attempt !== currentAttempt
        || expectedPrevious.agentId !== existingAgent
        || expectedPrevious.status !== row?.status
        || row?.assigned_to !== expectedPrevious.agentId
        || claimedAttempt !== currentAttempt
        || finishedAttempt !== currentAttempt
      ) {
        throw queueAttemptDuplicateExecutionError(taskId, requestedAttempt, 'invalid_transition');
      }
    } else if (
      claimedAttempt !== null
      || row?.status === 'running'
      || row?.status === 'streaming'
      || row?.status === 'in_progress'
    ) {
      throw queueAttemptDuplicateExecutionError(taskId, requestedAttempt, 'invalid_transition');
    }

    if (resolveMetadata) {
      Object.assign(metadata, resolveMetadata(agentId, metadata));
    }
    metadata.ncoQueueAttempt = attempt;
    metadata.ncoQueueAttemptAgentId = agentId;
    metadata.attemptedAgents = mergeAttemptedAgents(
      metadata.attemptedAgents,
      [agentId],
    );
    let queueOwnerInstanceId: string | null = null;
    let queueOwnerEpoch = 0;
    let queueExpiresAt: string | null = null;
    let recoveryPolicy: 'manual' | 'auto' = 'manual';
    if (ownershipEnabled) {
      recoveryPolicy = resolveExplicitTaskRecoveryPolicy(row!.mode, metadata);
      const existingOwnershipMatches = queueOwnershipMatches({
        ownerInstanceId: row!.queue_owner_instance_id,
        ownerEpoch: row!.queue_owner_epoch,
        queueExpiresAt: row!.queue_expires_at,
        metadata,
        attempt,
      });
      if (existingOwnershipMatches) {
        queueOwnerInstanceId = row!.queue_owner_instance_id!;
        queueOwnerEpoch = readQueueOwnerEpoch(row!.queue_owner_epoch)!;
        queueExpiresAt = row!.queue_expires_at!;
      } else {
        // Never replace an already claimed generation's owner. During a rolling
        // deploy an old worker may still be running; unknown ownership must stop,
        // not mint a fresh right to execute the same prompt.
        if (claimedAttempt === attempt) {
          throw queueAttemptDuplicateExecutionError(taskId, attempt, 'ownership_unknown');
        }
        queueOwnerInstanceId = TASK_QUEUE_OWNER_INSTANCE_ID;
        queueOwnerEpoch = Math.max(0, Number(row!.queue_owner_epoch) || 0) + 1;
        queueExpiresAt = sqliteUtcAfter(Date.now(), resolveQueueOwnershipLeaseMs());
        metadata.ncoQueueOwnerInstanceId = queueOwnerInstanceId;
        metadata.ncoQueueOwnerEpoch = queueOwnerEpoch;
        metadata.ncoQueueOwnerAttempt = attempt;
      }
    }
    const updated = ownershipEnabled
      ? db.prepare(`
          UPDATE tasks
          SET assigned_to=?, metadata_json=?, recovery_policy=?,
              queue_owner_instance_id=?, queue_owner_epoch=?, queue_expires_at=?,
              updated_at=datetime('now')
          WHERE id=? AND status=? AND assigned_to IS ?
        `).run(
          agentId,
          JSON.stringify(metadata),
          recoveryPolicy,
          queueOwnerInstanceId,
          queueOwnerEpoch,
          queueExpiresAt,
          taskId,
          row!.status,
          row!.assigned_to,
        )
      : db.prepare(`
          UPDATE tasks
          SET assigned_to=?, metadata_json=?, updated_at=datetime('now')
          WHERE id=? AND status=? AND assigned_to IS ?
        `).run(agentId, JSON.stringify(metadata), taskId, row!.status, row!.assigned_to);
    if (updated.changes !== 1) {
      throw queueAttemptDuplicateExecutionError(taskId, attempt, 'invalid_transition');
    }
    return { attempt, agentId, metadata };
  }).immediate();
}

/** Advance interrupted work to a fresh generation while preserving queued work. */
export function advanceQueueAttemptForRecovery(
  metadataJson: string | null,
  interrupted: boolean,
): string | null {
  if (!interrupted) return metadataJson;
  const metadata = parseTaskMetadataJson(metadataJson);
  metadata.ncoQueueAttempt = normalizeQueueAttempt(metadata.ncoQueueAttempt) + 1;
  delete metadata.ncoQueueAttemptAgentId;
  delete metadata.ncoQueueOwnerInstanceId;
  delete metadata.ncoQueueOwnerEpoch;
  delete metadata.ncoQueueOwnerAttempt;
  return JSON.stringify(metadata);
}

/**
 * 시도이력(attemptedAgents)은 단조 증가여야 한다 — 축소되면 이미 실패한 프로바이더가
 * 재선택된다.
 *
 * 실측 근거(T1, 2026-07-30 task_ATkeua4HRwS_T-tQ / team_tech-port-02-safety-license):
 * escalationHistory[0].attemptedAgents=["cursor-agent","codex","claude-code"]였는데
 * 최종 top-level attemptedAgents=["codex","hermes"]로 3→2 역행. 원인은 두 곳이다.
 *   (a) persistTaskReassignment이 `...metadataPatch`로 persisted 목록을 통째로 덮어씀
 *   (b) enqueueWithRetries가 DB가 아닌 BullMQ job data 스냅샷(task.metadata)에서 시딩
 * 결과: 06:11:39에 이미 queue_wait_timeout으로 실패한 codex가 재선택되어 30분을 더
 * 소진하고 07:23:59 timeout(idle)로 종료(result_json/evidence_json 모두 NULL, 산출물 0).
 * 당시 ollama(waiting 0)·opencode(waiting 0)는 미시도 상태로 유휴였다.
 *
 * 롤백: NCO_ATTEMPT_HISTORY_MONOTONIC=0 → union을 건너뛰고 정확히 이전(덮어쓰기) 동작.
 */
export function attemptHistoryMonotonicEnabled(
  toggle: string | undefined = process.env.NCO_ATTEMPT_HISTORY_MONOTONIC,
): boolean {
  return toggle?.trim() !== '0';
}

/** persisted 목록 ∪ 새 목록 (순서 보존, 중복 제거). 어느 쪽도 축소하지 않는다. */
export function mergeAttemptedAgents(
  persisted: unknown,
  incoming: readonly string[],
): string[] {
  const prior = Array.isArray(persisted)
    ? persisted.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
  const merged = [...prior];
  for (const agentId of incoming) {
    if (typeof agentId === 'string' && agentId.length > 0 && !merged.includes(agentId)) {
      merged.push(agentId);
    }
  }
  return merged;
}

export interface TaskReassignmentExpectation extends QueueAttemptAdvanceExpectation {
  nextAttempt: number;
}

export function persistTaskReassignment(
  taskId: string,
  previousAgentId: string,
  agentId: string,
  metadataPatch: { attemptedAgents: string[]; escalationHistory?: unknown[] },
  expectation?: TaskReassignmentExpectation,
): Record<string, unknown> {
  const db = getDb();
  const metadata = db.transaction(() => {
    const row = db.prepare(`
      SELECT status, assigned_to, metadata_json
      FROM tasks
      WHERE id=?
    `).get(taskId) as {
      status: string;
      assigned_to: string | null;
      metadata_json: string | null;
    } | undefined;
    const terminal = terminalDuplicateExecutionError(taskId, row?.status);
    if (terminal) throw terminal;

    const persistedMetadata = parseTaskMetadataJson(row!.metadata_json);
    if (row!.assigned_to !== previousAgentId) {
      throw queueAttemptDuplicateExecutionError(
        taskId,
        expectation?.nextAttempt ?? normalizeQueueAttempt(persistedMetadata.ncoQueueAttempt),
        'route_mismatch',
      );
    }
    const currentAttempt = readQueueAttempt(persistedMetadata.ncoQueueAttempt);
    const claimedAttempt = readQueueAttempt(persistedMetadata.ncoQueueAttemptClaimed);
    if (expectation) {
      if (
        expectation.nextAttempt !== expectation.attempt + 1
        || currentAttempt !== expectation.attempt
        || persistedMetadata.ncoQueueAttemptAgentId !== expectation.agentId
        || previousAgentId !== expectation.agentId
        || row!.status !== expectation.status
        || claimedAttempt !== expectation.attempt
        || readQueueAttempt(persistedMetadata.ncoQueueAttemptFinished) !== expectation.attempt
      ) {
        throw queueAttemptDuplicateExecutionError(
          taskId,
          expectation.nextAttempt,
          'invalid_transition',
        );
      }
    } else if (
      row!.status === 'running'
      || row!.status === 'streaming'
      || row!.status === 'in_progress'
      || (currentAttempt !== null && claimedAttempt === currentAttempt)
    ) {
      // Legacy callers may still reassign pre-dispatch assigned/queued tasks,
      // but an executing generation always requires the exact CAS contract.
      throw queueAttemptDuplicateExecutionError(
        taskId,
        normalizeQueueAttempt(currentAttempt),
        'invalid_transition',
      );
    }

    const nextMetadata: Record<string, unknown> & { attemptedAgents: string[] } = {
      ...persistedMetadata,
      ...metadataPatch,
      reassignedFrom: previousAgentId,
    };
    if (expectation) {
      nextMetadata.ncoQueueAttempt = expectation.nextAttempt;
      nextMetadata.ncoQueueAttemptAgentId = agentId;
      delete nextMetadata.ncoQueueOwnerInstanceId;
      delete nextMetadata.ncoQueueOwnerEpoch;
      delete nextMetadata.ncoQueueOwnerAttempt;
    }
    if (expectation || attemptHistoryMonotonicEnabled()) {
      nextMetadata.attemptedAgents = mergeAttemptedAgents(
        persistedMetadata.attemptedAgents,
        metadataPatch.attemptedAgents ?? [],
      );
    }
    const updated = db.prepare(`
      UPDATE tasks
      SET assigned_to=?, metadata_json=?, updated_at=datetime('now')
      WHERE id=? AND status=? AND assigned_to=?
    `).run(agentId, JSON.stringify(nextMetadata), taskId, row!.status, previousAgentId);
    if (updated.changes !== 1) {
      throw queueAttemptDuplicateExecutionError(
        taskId,
        expectation?.nextAttempt ?? normalizeQueueAttempt(nextMetadata.ncoQueueAttempt),
        'invalid_transition',
      );
    }
    return nextMetadata;
  }).immediate();
  logDecision({
    taskId,
    phase: 'execution',
    decision: `reassign:${previousAgentId}->${agentId}`,
    actor: 'task-queue',
  });
  return metadata;
}

const SILENT_FAILURE_PATTERN = /usage limit|rate limit exceeded|quota exceeded|user not found|unauthorized|invalid api key|\b401\b|payment required|credit/i;
const HEADLESS_PERMISSION_DENIAL_DISABLED = new Set(['0', 'false', 'off']);
const HEADLESS_PERMISSION_DENIAL_PATTERN =
  /^jetski:\s*no output produced\b[\s\S]{0,240}\bheadless mode cannot prompt for,\s*so it was auto-denied\./i;

/**
 * Jetski can exit successfully after refusing a required tool in headless mode. The CLI's
 * exact leading envelope is provider failure evidence, not a task result. Keep the match
 * anchored and bounded so a report that merely quotes an earlier incident is not rejected.
 * Runtime rollback: NCO_HEADLESS_PERMISSION_DENIAL_GATE=off.
 */
export function classifyResult(
  result: TaskExecutionResult,
  headlessPermissionDenialToggle = process.env.NCO_HEADLESS_PERMISSION_DENIAL_GATE,
): TaskExecutionResult {
  if (!result.success) return result;

  const output = result.output ?? '';
  const trimmed = output.trim();

  if (trimmed.length === 0) {
    return { ...result, success: false, output, error: 'silent-failure: empty output' };
  }

  if (trimmed === '(에이전트 응답 없음)') {
    return { ...result, success: false, output, error: 'silent-failure: no agent response' };
  }

  if (
    !HEADLESS_PERMISSION_DENIAL_DISABLED.has(
      headlessPermissionDenialToggle?.trim().toLowerCase() ?? '',
    )
    && HEADLESS_PERMISSION_DENIAL_PATTERN.test(trimmed)
  ) {
    return {
      ...result,
      success: false,
      output,
      error: 'silent-failure: headless tool permission auto-denied',
    };
  }

  if (output.length < 300 && SILENT_FAILURE_PATTERN.test(output)) {
    return { ...result, success: false, output, error: 'silent-failure: limit or credential message' };
  }

  // 위 분기는 300자 미만만 본다. 그래서 **긴 오류 본문이 그대로 통과**한다. claude-2 가
  // 2회 독립 재현: hermes 가 쿼터 오류를 본문으로 뱉고 exit 0 → 큐는 +1 완료로 세는데
  // DB 는 나중에 +1 실패로 기록돼 두 장부가 어긋났다(2026-08-06). 길이 제한 없이,
  // 대신 오탐이 0 으로 실측된 좁은 관용구 집합으로만 판정한다(provider-error-body.ts).
  if (isProviderErrorBody(output)) {
    return { ...result, success: false, output, error: 'silent-failure: provider error body (exit 0)' };
  }

  return result;
}

// ── P11: 단일 팀 위임 provider failover 지원 ─────────────────────────────
// 정상완료·사용자취소·rate-limit은 제외. 같은 provider 재시도로 회복되지 않는
// queue/auth/CLI-process 실패도 팀 내부의 다음 실행자로 한 번 전환할 수 있게 한다.
export function isTransientFailure(result: TaskExecutionResult): boolean {
  if (result.success) return false;                 // 정상완료는 절대 재시도 안 함(오탐 방지)
  if (result.status === 'cancelled') return false;  // 사용자 취소 재시도 금지
  const err = result.error ?? '';
  if (
    /\b(?:verifier failed|quality_rejected|evidence_gate_blocked|(?:user|operator)[ _-]?cancelled)\b/i.test(err)
    || /\b(?:CLI|subprocess) cancelled\b/i.test(err)
  ) return false;                                  // 정책/사용자 종결은 provider failover 금지
  if (isRateLimitError(err)) return false;          // 기존 backoff/failover 경로와 중복 금지
  // spawn 자원 부족은 명백한 일시 실패다. 커널이 fork 시점에 거부한 것이라 같은 요청을
  // 잠시 뒤 다시 하면 통과할 수 있고, 다른 프로바이더로 넘겨도 된다.
  //
  // **확인된 사실**(kangnote 기기, 2026-08-06 WSL2):
  //  - PM2 로그 원문에 `Command failed with ENOMEM: opencode run --pure ...` 가 있고,
  //    토론 세션 2건이 모두 이것 때문에 `discussion_insufficient_valid_proposals:0/2`
  //    로 끝났다(R1 실패 → 1회 재시도 → 같은 ENOMEM).
  //  - 그 시각 시스템은 19Gi 중 15Gi available 이었다. 즉 **단순 메모리 부족이 아니다.**
  //
  // **원인은 미확인이다.** overcommit 휴리스틱 거부라는 가설이 나왔으나 같은 기기에서
  // 재현에 실패해 철회됐다 — 그 node 로 RSS 를 43MB~1,644MB 까지 키우며 spawn 을
  // 반복해도 전부 성공했고(NCO 백엔드 RSS 682MB 의 두 배 조건 포함), 커널 지표
  // (CommitLimit 14.6Gi / Committed_AS 56.1Gi)는 재현 시도 시점에도 동일했다.
  // 따라서 Committed_AS 초과 자체는 범인이 아니다. 남은 후보로 execa 버퍼 할당 실패가
  // 거론됐으나 미검증이다. **여기에 원인을 단정해 적지 말 것.**
  //
  // 원인과 무관하게 분류는 타당하다. spawn 자원 오류는 같은 요청을 잠시 뒤 다시 하면
  // 통과할 수 있고 다른 프로바이더로 넘겨도 된다. 이 분류가 없으면 위 0/2 처럼 토론이
  // 그대로 죽는다. Node/libuv 의 spawn 은 fork+exec 라 경로 자체를 코드에서 못 바꾼다.
  if (/\b(?:ENOMEM|EAGAIN)\b/.test(err)) return true;
  return err.startsWith('silent-failure:')            // classifyResult: 빈출력/무응답/limit메시지
      || err === 'timeout(idle)'                      // idle 타임아웃(활동 없음)
      || /aborting operation|aborted by (the )?provider/i.test(err) // 프로바이더측 abort
      || /\bqueue_wait_timeout\b/i.test(err)           // 실행 전 provider queue 포화
      || /\b(?:circuit breaker open|provider[_ -]unavailable)\b/i.test(err)
      || /\b(?:invalid api key|credential preflight failed|unauthorized)\b/i.test(err)
      || /\bprovider failure detected:\s*auth\b/i.test(err)
      || /\b(?:CLI failed exit=|CLI timed out|subprocess exited with code|subprocess timed out)\b/i.test(err);
}

// 팀 밖 provider failover는 새 provider 예산을 쓰므로 정확한 opt-in만 허용한다.
export function allowGenericProviderFailover(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.allowProviderFailover === true;
}

const CIRCUIT_COOLDOWN_WAIT_CAP_MS = 30_000;
const CIRCUIT_COOLDOWN_WAIT_BUFFER_MS = 200;
const CIRCUIT_COOLDOWN_WAIT_DISABLED = new Set(['0', 'false', 'off']);

/** 기본 on. `NCO_CIRCUIT_COOLDOWN_WAIT=off`이면 즉시 실행(종전 동작)으로 복귀한다. */
export function isCircuitCooldownWaitEnabled(
  toggle: string | undefined = process.env.NCO_CIRCUIT_COOLDOWN_WAIT,
): boolean {
  return !CIRCUIT_COOLDOWN_WAIT_DISABLED.has(toggle?.trim().toLowerCase() ?? '');
}

/**
 * open circuit cooldown이 곧 끝나면 실행 전 bounded wait(ms)를 반환한다.
 * 즉시 execute하면 provider_unavailable(iterations:0)으로 실패하는 CB 실패를 줄인다.
 * auth·cooldownUntil 없음·이미 available이면 0.
 */
export function computeCircuitCooldownWaitMs(
  agentId: string,
  now = Date.now(),
  capMs = CIRCUIT_COOLDOWN_WAIT_CAP_MS,
): number {
  const availability = circuitBreakerRegistry.getAvailability(agentId);
  if (availability.available) return 0;
  if (availability.reason === 'auth' || availability.reason === 'quota') return 0;
  const until = availability.cooldownUntil ? Date.parse(availability.cooldownUntil) : Number.NaN;
  if (!Number.isFinite(until)) return 0;
  const remaining = until - now;
  if (remaining <= 0) return 0;
  const buffered = remaining + CIRCUIT_COOLDOWN_WAIT_BUFFER_MS;
  return buffered <= capMs ? buffered : 0;
}

const EVOLUTION_LEARNING_TEAM_SLUG = 'gov-evolution-learning';
const EVOLUTION_LEARNING_RECOVERY_PATTERN =
  /\b(?:queue_wait_timeout|session limit|invalid x-api-key|invalid api key|authentication_error|unauthorized|credential preflight failed|provider[_ -]unavailable)\b/i;
const RECOVERY_CHECKPOINT_TEAM_ID = 'team_tech-port-03-recovery-checkpoint';
const RECOVERY_CHECKPOINT_CLAUDE_AVOID_DISABLED = new Set(['0', 'false', 'off']);
const EVOLUTION_SKILLS_TEAM_ID = 'team_gov-evolution-skills';
const EVOLUTION_SKILLS_CLAUDE_AVOID_DISABLED = new Set(['0', 'false', 'off']);
const COMMANDER_LANE_AGENT_ID = 'claude-code';
const COMMANDER_LANE_CLAUDE_AVOID_DISABLED = new Set(['0', 'false', 'off']);

/**
 * Recovery Checkpoint task evidence showed generic tier escalation repeatedly
 * leaving the configured team and selecting claude-code:
 * - task_FagxTX_VomD7kBJW / task__MWoa1v_19N_msrZ: queue_wait_timeout
 * - task_lfZ0JKlPFz_0xVUI: weekly limit
 *
 * Keep the mitigation bounded to this team and only to the escalation candidate
 * list. Team membership, lifecycle state, and every other provider/team remain
 * unchanged. Runtime rollback: NCO_RECOVERY_CHECKPOINT_CLAUDE_AVOID=off.
 */
export function filterRecoveryCheckpointEscalationAgents(
  teamId: unknown,
  agentIds: readonly string[],
  toggle = process.env.NCO_RECOVERY_CHECKPOINT_CLAUDE_AVOID,
): string[] {
  const disabled = RECOVERY_CHECKPOINT_CLAUDE_AVOID_DISABLED.has(
    toggle?.trim().toLowerCase() ?? '',
  );
  if (disabled || teamId !== RECOVERY_CHECKPOINT_TEAM_ID) {
    return [...agentIds];
  }
  return agentIds.filter((agentId) => agentId !== 'claude-code');
}

/**
 * Skill Academy (gov-evolution-skills) 48h evidence (2026-07-28):
 * - task_K0WzIJ30V7g4XqNi: codex queue_wait → escalated to claude-code →
 *   terminal `queue_wait_timeout: provider claude-code busy for 1800000ms`
 * - task_EOKPfKyrTYcNmGaX: ollama→cursor-agent→claude-code →
 *   terminal weekly-limit subprocess exit
 *
 * Both scored failures landed on claude-code after generic tier escalation.
 * Keep mitigation team-scoped to escalation candidates only (membership/lifecycle
 * unchanged). Runtime rollback: NCO_EVOLUTION_SKILLS_CLAUDE_AVOID=off.
 */
export function filterEvolutionSkillsEscalationAgents(
  teamId: unknown,
  agentIds: readonly string[],
  toggle = process.env.NCO_EVOLUTION_SKILLS_CLAUDE_AVOID,
): string[] {
  const disabled = EVOLUTION_SKILLS_CLAUDE_AVOID_DISABLED.has(
    toggle?.trim().toLowerCase() ?? '',
  );
  if (disabled || teamId !== EVOLUTION_SKILLS_TEAM_ID) {
    return [...agentIds];
  }
  return agentIds.filter((agentId) => agentId !== 'claude-code');
}

/**
 * 24h 라이브 실측(2026-08-06, ~/.nova/nova-suite/data/nco/nco.db): claude-code 에
 * 1,078건이 배정돼 실패 362건이 났다. 사유는 lease_expired_twice 306건 +
 * `queue_wait_timeout: provider claude-code busy` 40건으로, 전체의 96%가 "차례를
 * 못 받아서" 죽은 것이다. 프로바이더 결함이 아니라 lane 폭 문제다.
 *
 * config/ai-providers.local.json 의 claude-code 는 concurrency=1 이고 note 에
 * "2026-07-23 Triad: Claude Commander/Judge 단일 lane. 계획·위험·판정 전담,
 * 구현 반복 금지" 라는 사용자 지시가 박혀 있다. 1-wide 는 오설정이 아니라 의도이므로
 * 넓혀서 해결하면 안 된다. 줄여야 할 것은 유입이다.
 *
 * 위 두 함수는 같은 증상에 팀 하나씩 사후적으로 붙인 완화다. 그러나 실패는
 * gov-command-strategic 34 · ax-decision-coordination-2026 32 ·
 * gov-engineering-architecture 30 · gov-evolution-evaluation 26 ·
 * gov-command-intake 26 … 처럼 팀 전반에 퍼져 있어 팀 ID 열거로는 따라잡지 못한다.
 * 그래서 generic tier 에스컬레이션 후보에서만 전역으로 제외한다.
 *
 * 범위는 좁게 유지한다 — 명시적 직접 배정(`POST /api/task` `ai=claude-code`), 팀
 * 정원, 라이프사이클, 다른 프로바이더는 전부 그대로다. 바뀌는 것은 "원 담당이
 * 실패했으니 남은 후보 중 아무나 잡아라" 경로 하나뿐이고, 그 경로가 밀어 넣는 일감이
 * 정확히 지시가 금지한 "구현 반복"이다. 후보가 claude-code 뿐이면 빈 목록을 반환하는
 * 대신 원본을 유지해, 이 필터가 에스컬레이션 자체를 막아 태스크를 굶기지 않게 한다.
 * 런타임 롤백: NCO_ESCALATION_CLAUDE_AVOID=off
 */
export function filterCommanderLaneEscalationAgents(
  agentIds: readonly string[],
  toggle = process.env.NCO_ESCALATION_CLAUDE_AVOID,
): string[] {
  const disabled = COMMANDER_LANE_CLAUDE_AVOID_DISABLED.has(
    toggle?.trim().toLowerCase() ?? '',
  );
  if (disabled) return [...agentIds];
  const remaining = agentIds.filter((agentId) => agentId !== COMMANDER_LANE_AGENT_ID);
  return remaining.length > 0 ? remaining : [...agentIds];
}

/**
 * Keep every failover selector on the same durable quota fence. Circuit state
 * alone is insufficient because a provider can have an active, persisted
 * rate-limit window while its circuit remains closed after a restart.
 *
 * A missing/unreadable durable state is fail-closed: escalation must not be a
 * weaker provider-I/O boundary than the final AgentManager admission gate.
 */
export function filterActivelyRateLimitedAgents(
  agentIds: readonly string[],
  db: Database.Database = getDb(),
): string[] {
  try {
    const limited = listActivelyRateLimited(db);
    return agentIds.filter((agentId) => !limited.has(agentId));
  } catch {
    // Escalation is still provider I/O admission. If the durable SSOT cannot
    // be read, allowing every candidate would bypass the fail-closed boundary
    // used by AgentManager and route work to a possibly exhausted account.
    return [];
  }
}

function loadTaskTeamId(taskId: string): string | null {
  const row = getDb().prepare(
    'SELECT team_id FROM tasks WHERE id=?',
  ).get(taskId) as { team_id: string | null } | undefined;
  return row?.team_id ?? null;
}

/**
 * Continuous Learning cycle-2 evidence showed a lead session-limit followed by
 * a fallback 401 body. Keep the extra recovery classification team-scoped and
 * accept evidence from either the normalized error or provider output.
 */
export function isEvolutionLearningRecoverableFailure(
  teamSlug: string | null | undefined,
  result: TaskExecutionResult,
): boolean {
  if (
    teamSlug !== EVOLUTION_LEARNING_TEAM_SLUG
    || result.success
    || result.status === 'cancelled'
  ) {
    return false;
  }
  return EVOLUTION_LEARNING_RECOVERY_PATTERN.test(
    `${result.error ?? ''}\n${result.output ?? ''}`,
  );
}

function isEvolutionLearningTaskRecoverableFailure(
  taskId: string,
  result: TaskExecutionResult,
): boolean {
  const row = getDb().prepare(`
    SELECT t.slug
    FROM tasks k
    JOIN teams t ON t.id = k.team_id
    WHERE k.id=?
  `).get(taskId) as { slug: string } | undefined;
  return isEvolutionLearningRecoverableFailure(row?.slug, result);
}

// team_id(태스크 DB 컬럼)로 TeamRow(lead+members) 로드. company-orchestrator.loadTeams와 동일 스키마.
function loadTeamRowById(teamId: string): TeamRow | null {
  const db = getDb();
  const t = db.prepare(
    `SELECT id, name, slug, lead, charter, description FROM teams WHERE id=? AND is_active=1`
  ).get(teamId) as { id: string; name: string; slug: string; lead: string | null; charter: string | null; description: string | null } | undefined;
  if (!t) return null;
  const members = (db.prepare(
    `SELECT member_ref FROM team_members WHERE team_id=? ORDER BY created_at ASC, id ASC`
  ).all(teamId) as Array<{ member_ref: string }>).map((r) => r.member_ref);
  return { ...t, members };
}

// 팀 체인에서 "아직 안 시도 + 모델검증 통과" 첫 실행자. 없으면 null(→ 기존 escalation 폴백).
// resolveExecutorChain + providerModelDispatchable 재사용(중복금지).
export async function nextTeamExecutor(
  taskId: string,
  knownAgents: Set<string>,
  attempted: string[],
  isModelDispatchable: (agentId: string) => Promise<boolean> = providerModelDispatchable,
): Promise<string | null> {
  const teamId = loadTaskTeamId(taskId);
  if (!teamId) return null;                          // 팀 태스크 아님 → P11 스킵
  const team = loadTeamRowById(teamId);
  if (!team) return null;
  // Remove rate-limited providers from the known set itself. resolveExecutorChain
  // deliberately appends registered-but-unavailable members as a last resort,
  // so checking only its availability callback would reintroduce them.
  const eligibleAgents = new Set(filterActivelyRateLimitedAgents([...knownAgents]));
  const avail: AvailabilityFn = (id) => {
    if (!eligibleAgents.has(id)) return false;
    if (!isProviderQualified(id)) return false;
    try { return circuitBreakerRegistry.getAvailability(id).available; } catch { return true; }
  };
  const chain = resolveExecutorChain(team, eligibleAgents, 'ollama', avail);
  for (const cand of chain) {
    if (attempted.includes(cand)) continue;          // 이미 시도한(=실패한) 실행자 제외
    if (!await isModelDispatchable(cand)) continue;  // 모델 존재 검증 통과자만
    // providerModelDispatchable() can perform asynchronous I/O. Re-read the
    // durable fence after that await so a newly limited provider cannot be
    // returned from a stale candidate snapshot.
    if (!resolveProviderRateLimitAdmission(cand).allowed) continue;
    return cand;
  }
  return null;
}

function mergeVerifierOutput(stdout: string, stderr: string): string {
  return `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.slice(0, 2000);
}

export function persistVerifierResultToDb(
  db: Database.Database,
  taskId: string,
  verifierResult: VerifierResult,
): void {
  db.prepare(`
    UPDATE tasks
    SET verifier_result_json=?, updated_at=datetime('now')
    WHERE id=?
  `).run(JSON.stringify(verifierResult), taskId);
}

function persistVerifierResult(taskId: string, verifierResult: VerifierResult): void {
  persistVerifierResultToDb(getDb(), taskId, verifierResult);
}

async function waitForExitWithTimeout(
  child: ChildProcessByStdio<null, Readable, Readable>,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const OUTPUT_LIMIT = 64 * 1024;
  let stdout = '';
  let stderr = '';
  let timedOut = false;

  child.stdout.on('data', chunk => {
    if (stdout.length >= OUTPUT_LIMIT) return;
    const text = chunk.toString();
    stdout += text.slice(0, OUTPUT_LIMIT - stdout.length);
  });
  child.stderr.on('data', chunk => {
    if (stderr.length >= OUTPUT_LIMIT) return;
    const text = chunk.toString();
    stderr += text.slice(0, OUTPUT_LIMIT - stderr.length);
  });

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        child.kill('SIGKILL');
        return;
      }
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);

    child.once('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    child.once('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export type VerifierProcessPhase = 'pre-task-baseline' | 'head-baseline' | 'post-task-verifier';

function terminateUntrackedVerifierChild(
  child: ChildProcessByStdio<null, Readable, Readable>,
): void {
  if (process.platform !== 'win32' && child.pid != null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // The child may have exited between spawn and registration. Fall through
      // to the ChildProcess handle, which is still safe for the child we own.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already exited.
  }
}

/**
 * Durably track every detached verifier child before waiting for it.
 *
 * A task uses its single `runtime_processes.task_id` slot serially: the
 * pre-task baseline finishes before provider dispatch, the provider is
 * finalized before the post-task verifier, and the HEAD baseline can run only
 * after that verifier exits. Keeping that invariant avoids a schema rewrite
 * while still giving startup hygiene and shutdown reaping the same verified
 * PID/PGID/command/start-token evidence used for provider children.
 *
 * Registration is fail-closed. An untracked detached verifier is terminated
 * immediately instead of being allowed to become an orphan after owner exit.
 */
export async function waitForTrackedVerifierProcess(
  task: Pick<QueuedTask, 'taskId' | 'agentId'>,
  phase: VerifierProcessPhase,
  child: ChildProcessByStdio<null, Readable, Readable>,
  timeoutMs: number,
  database: Database.Database = getDb(),
  registryDependencies: ProcessRegistryDependencies = {},
): Promise<VerifierProcessResult> {
  // Attach error/close listeners before registry inspection. AbortSignal can
  // otherwise emit an asynchronous AbortError while fail-closed registration
  // cleanup is running, which would become an uncaught process error.
  const exit = waitForExitWithTimeout(child, timeoutMs);
  const pid = child.pid;
  const registered = pid != null && registerRuntimeProcess(
    { taskId: task.taskId, agentId: task.agentId, pid },
    database,
    registryDependencies,
  );
  if (!registered || pid == null) {
    terminateUntrackedVerifierChild(child);
    try {
      await exit;
    } catch {
      // The tracking failure below is the stable, operator-facing reason.
    }
    throw new Error(`verifier process tracking failed (${phase})`);
  }

  try {
    return await exit;
  } finally {
    unregisterRuntimeProcess(task.taskId, database, pid);
  }
}

/**
 * Capture the verifier result before the agent can mutate the task worktree.
 *
 * This is intentionally per execution rather than a cwd/command TTL cache:
 * another task can change the same shared worktree between cache reads, so a
 * cached failure is not proof of this task's pre-existing state.
 */
export async function captureVerifierBaseline(
  task: QueuedTask,
  controllerSignal: AbortSignal,
): Promise<VerifierProcessResult | null> {
  if (task.verifier?.type !== 'run') return null;

  const timeoutMs = task.verifier.timeoutMs ?? 60_000;
  const [binary, ...args] = task.verifier.command.trim().split(/\s+/);
  if (!binary || binary.includes('/') || binary.includes('\\')) return null;
  if (!verifierCommandGate.validate(binary, args).ok) return null;

  const projectDir = resolveVerifierProjectDir(task);
  try {
    const child = spawn(binary, args, {
      cwd: projectDir,
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: controllerSignal,
    });
    return await waitForTrackedVerifierProcess(
      task,
      'pre-task-baseline',
      child,
      timeoutMs,
    );
  } catch (error) {
    log.warn({
      taskId: task.taskId,
      cwd: projectDir,
      command: task.verifier.command,
      error: error instanceof Error ? error.message : String(error),
    }, 'Pre-task verifier baseline could not be captured');
    return null;
  }
}

/**
 * Run the verifier on a clean HEAD checkout to distinguish pre-existing
 * build failures from task-caused regressions. Symlinks node_modules
 * from the working project so build tools resolve dependencies.
 */
export async function captureHeadBaseline(
  task: QueuedTask,
  signal: AbortSignal,
): Promise<VerifierProcessResult | null> {
  if (task.verifier?.type !== 'run') return null;

  // 호스트 포화 방지 (2026-07-30 T1): 이 함수는 태스크마다 git worktree + `npm run build`
  // (tsc/esbuild)를 띄운다. 상한이 없어 tsc 10개·esbuild 8개가 동시에 돌아 16코어 머신의
  // load average 가 64까지 올라갔고, NCO 자신의 이벤트루프가 굶어 전 API 가 000(8~10s
  // 타임아웃)이 됐다. 그 결과 헬스프로브가 타임아웃 → CB open → F1 CB-cascade 로 번졌다.
  // 상한은 env 로 조절 가능(0 이하나 비수치는 기본값).
  const gate = getVerifierBuildSemaphore();
  const waitStartedAt = gate.isSaturated() ? Date.now() : null;
  if (waitStartedAt !== null) verifierBuildStats.waiting++;
  try {
    await gate.acquire();
  } finally {
    if (waitStartedAt !== null) verifierBuildStats.waiting--;
  }

  verifierBuildStats.currentRunning++;
  verifierBuildStats.totalRuns++;
  verifierBuildStats.maxConcurrent = Math.max(
    verifierBuildStats.maxConcurrent,
    verifierBuildStats.currentRunning,
  );
  if (waitStartedAt !== null) {
    log.info({
      taskId: task.taskId,
      waitMs: Date.now() - waitStartedAt,
      ...getVerifierBuildStats(),
    }, 'Verifier build waited for concurrency slot');
  }

  try {
    return await captureHeadBaselineInner(task, signal);
  } finally {
    verifierBuildStats.currentRunning = Math.max(0, verifierBuildStats.currentRunning - 1);
    gate.release();
  }
}

/** 검증 빌드 동시 실행 상한 — CPU 코어의 1/4, 최소 1·최대 4. `NCO_VERIFIER_BUILD_CONCURRENCY` 로 override. */
function resolveVerifierBuildConcurrency(): number {
  const raw = Number(process.env.NCO_VERIFIER_BUILD_CONCURRENCY);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  const cores = typeof availableParallelism === 'function' ? availableParallelism() : 4;
  return Math.min(4, Math.max(1, Math.floor(cores / 4)));
}

async function captureHeadBaselineInner(
  task: QueuedTask,
  signal: AbortSignal,
): Promise<VerifierProcessResult | null> {
  if (task.verifier?.type !== 'run') return null;

  const timeoutMs = task.verifier.timeoutMs ?? 60_000;
  const [binary, ...args] = task.verifier.command.trim().split(/\s+/);
  if (!binary || binary.includes('/') || binary.includes('\\')) return null;
  if (!verifierCommandGate.validate(binary, args).ok) return null;

  const projectDir = resolveVerifierProjectDir(task);
  const tmpDir = mkdtempSync(join(tmpdir(), 'nco-verify-head-'));

  try {
    execFileSync('git', ['worktree', 'add', '--detach', tmpDir, 'HEAD'], {
      cwd: projectDir,
      stdio: 'ignore',
      timeout: 30_000,
    });

    const nmSrc = join(projectDir, 'node_modules');
    if (existsSync(nmSrc)) {
      symlinkSync(nmSrc, join(tmpDir, 'node_modules'));
    }

    const child = spawn(binary, args, {
      cwd: tmpDir,
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    return await waitForTrackedVerifierProcess(
      task,
      'head-baseline',
      child,
      timeoutMs,
    );
  } catch (error) {
    log.warn({
      taskId: task.taskId,
      cwd: projectDir,
      command: task.verifier.command,
      error: error instanceof Error ? error.message : String(error),
    }, 'HEAD-clean verifier baseline could not be captured; verifier remains failed');
    return null;
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', tmpDir], {
        cwd: projectDir,
        stdio: 'ignore',
        timeout: 15_000,
      });
    } catch { /* cleanup best-effort */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* already removed */ }
  }
}

export async function applyVerifierGate(
  task: QueuedTask,
  classified: TaskExecutionResult,
  controllerSignal: AbortSignal,
  preTaskBaseline: VerifierProcessResult | null = null,
): Promise<TaskExecutionResult> {
  if (!classified.success) {
    return classified;
  }

  // P1-6 evidence-gate opt-in 하드차단: 태스크가 metadata_json.requiredEvidence를 선언하면
  // 해당 증거가 모두 있어야 성공. 없으면 completed→failed 강등(evidence_gate_blocked).
  // 선언 없으면(기본) 완전 무영향.
  const taskMetadata = task.metadata ?? {};
  const taskDeclaresEvidence = Object.prototype.hasOwnProperty.call(taskMetadata, 'requiredEvidence');
  let evidenceDeclared = taskDeclaresEvidence;
  let evidenceStage = 'metadata lookup';
  const blockEvidence = (reason: string): TaskExecutionResult => ({
    ...classified,
    success: false,
    status: 'failed',
    error: [classified.error, `evidence_gate_blocked: ${reason}`].filter(Boolean).join('\n\n'),
  });
  try {
    const db = getDb();
    const row = db.prepare('SELECT metadata_json FROM tasks WHERE id=?').get(task.taskId) as { metadata_json: string | null } | undefined;
    if (!row && evidenceDeclared) {
      return blockEvidence('task metadata unavailable');
    }

    const rawMetadata = row?.metadata_json;
    if (rawMetadata && /"requiredEvidence"\s*:/.test(rawMetadata)) {
      evidenceDeclared = true;
    }
    let metadata: Record<string, unknown> = {};
    if (rawMetadata) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawMetadata);
      } catch {
        if (evidenceDeclared) return blockEvidence('invalid metadata_json');
        parsed = {};
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        if (evidenceDeclared) return blockEvidence('invalid metadata_json');
      } else {
        metadata = parsed as Record<string, unknown>;
      }
    }

    const dbDeclaresEvidence = Object.prototype.hasOwnProperty.call(metadata, 'requiredEvidence');
    evidenceDeclared ||= dbDeclaresEvidence;
    const requiredKinds: string[] = [];
    for (const [declared, value] of [
      [dbDeclaresEvidence, metadata.requiredEvidence],
      [taskDeclaresEvidence, taskMetadata.requiredEvidence],
    ] as const) {
      if (!declared) continue;
      if (
        !Array.isArray(value)
        || !value.every(kind => typeof kind === 'string' && kind.trim().length > 0)
      ) {
        return blockEvidence('invalid requiredEvidence schema');
      }
      for (const kind of value) {
        const normalized = kind.trim();
        if (!requiredKinds.includes(normalized)) requiredKinds.push(normalized);
      }
    }

    if (requiredKinds.length > 0) {
      evidenceStage = 'evidence ledger query';
      const actions = db.prepare(`
        SELECT source_event_id AS sourceEventId,
               event_type AS eventType,
               detail_json AS detailJson
        FROM work_events
        WHERE task_id=?
          AND source='event-bus'
          AND event_type IN (
            'action:readFile', 'action:listFiles', 'action:searchCode',
            'action:searchFiles', 'action:runCommand', 'action:runTest',
            'action:gitDiff', 'action:gitStatus'
          )
        ORDER BY occurred_at, id
      `).all(task.taskId) as PersistedToolAction[];
      const projectDir = typeof metadata.projectDir === 'string' && metadata.projectDir.trim()
        ? metadata.projectDir
        : resolveVerifierProjectDir(task);
      evidenceStage = 'evidence evaluation';
      const trustedEvidence = collectTrustedToolEvidence(actions, requiredKinds, projectDir);
      const gate = requireEvidence(trustedEvidence, requiredKinds);
      if (!gate.allowed) {
        return blockEvidence(`missing ${gate.missing.join(', ')}`);
      }
      classified = { ...classified, evidenceJson: JSON.stringify(trustedEvidence) };
    }
  } catch (err) {
    log.warn({ taskId: task.taskId, stage: evidenceStage, err: (err as Error).message }, 'evidence gate check failed');
    if (evidenceDeclared) return blockEvidence(`${evidenceStage} failed`);
  }

  if (task.verifier?.type !== 'run') {
    return classified;
  }

  const startedAt = new Date().toISOString();
  const timeoutMs = task.verifier.timeoutMs ?? 60_000;
  const [binary, ...args] = task.verifier.command.trim().split(/\s+/);

  if (!binary) {
    const reason = 'Missing verifier binary';
    const verifierResult: VerifierResult = {
      type: 'run',
      command: task.verifier.command,
      timeoutMs,
      startedAt,
      exitCode: null,
      timedOut: false,
      passed: false,
      outputSnippet: reason,
      spawnError: `CommandGate: ${reason}`,
    };
    try {
      persistVerifierResult(task.taskId, verifierResult);
    } catch (err) {
      log.warn({ taskId: task.taskId, err }, 'Failed to persist verifier result');
    }

    return {
      ...classified,
      success: false,
      error: [classified.error, `verifier failed: ${reason}`].filter(Boolean).join('\n\n'),
    };
  }

  if (binary.includes('/') || binary.includes('\\')) {
    const reason = 'CommandGate: path-based binary not allowed';
    const verifierResult: VerifierResult = {
      type: 'run',
      command: task.verifier.command,
      timeoutMs,
      startedAt,
      exitCode: null,
      timedOut: false,
      passed: false,
      outputSnippet: reason,
      spawnError: reason,
    };
    try {
      persistVerifierResult(task.taskId, verifierResult);
    } catch (err) {
      log.warn({ taskId: task.taskId, err }, 'Failed to persist verifier result');
    }

    return {
      ...classified,
      success: false,
      error: [classified.error, `verifier failed: ${reason}`].filter(Boolean).join('\n\n'),
    };
  }

  const gateResult = verifierCommandGate.validate(binary, args);
  if (!gateResult.ok) {
    const reason = gateResult.reason ?? 'Unknown command gate rejection';
    const verifierResult: VerifierResult = {
      type: 'run',
      command: task.verifier.command,
      timeoutMs,
      startedAt,
      exitCode: null,
      timedOut: false,
      passed: false,
      outputSnippet: reason,
      spawnError: `CommandGate: ${reason}`,
    };
    try {
      persistVerifierResult(task.taskId, verifierResult);
    } catch (err) {
      log.warn({ taskId: task.taskId, err }, 'Failed to persist verifier result');
    }

    return {
      ...classified,
      success: false,
      error: [classified.error, `verifier failed: ${reason}`].filter(Boolean).join('\n\n'),
    };
  }

  try {
    const projectDir = resolveVerifierProjectDir(task);
    const child = spawn(binary, args, {
      cwd: projectDir,
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: controllerSignal,
    });
    const { code, stdout, stderr, timedOut } = await waitForTrackedVerifierProcess(
      task,
      'post-task-verifier',
      child,
      timeoutMs,
    );
    const outputSnippet = mergeVerifierOutput(stdout, stderr);
    const passed = code === 0 && !timedOut;
    const verifierResult: VerifierResult = {
      type: 'run',
      command: task.verifier.command,
      timeoutMs,
      startedAt,
      exitCode: code,
      timedOut,
      passed,
      outputSnippet,
    };
    if (passed) {
      try {
        persistVerifierResult(task.taskId, verifierResult);
      } catch (err) {
        log.warn({ taskId: task.taskId, err }, 'Failed to persist verifier result');
      }
      return classified;
    }

    // **baseline 이 없는 것을 "baseline 이 깨끗했다"로 취급하면 안 된다.**
    // 초판은 `preTaskBaseline &&` 로 시작해 null 이면 이 블록을 통째로 건너뛰었다.
    // 그러면 HEAD 대조를 아예 안 해서 **기존에 깨져 있던 빌드가 정답을 실패로 뒤집는다.**
    //
    // 실측(gentop, 2026-08-07): claude-code 에 단순 산술을 위임해 응답 391 로 정확했는데
    // status 가 failed 였다. 사유는 `verifier failed: tsc 오류 3건` 이고 그 오류는 태스크와
    // 무관한 프로젝트 전체의 기존 결함이었다. projectDir 를 빈 디렉터리로 바꿔 같은 위임을
    // 다시 하니 completed 가 떴다 — 즉 태스크가 아니라 프로젝트 상태가 판정을 뒤집었다.
    //
    // `captureVerifierBaseline` 은 어떤 이유로든 실패하면 `log.warn` 만 남기고 null 을
    // 낸다(kangnote 가 FK 제약 실패 경로를 T1 로 규명). 반환값만 보면 "baseline 정상 통과"와
    // 구분이 안 된다. 그래서 null 을 **판정 불가**로 명시해 HEAD 대조로 넘긴다:
    //   HEAD 도 실패 → 기존 결함이므로 verifier 를 건너뛴다
    //   HEAD 는 통과 → 기존 결함이 아니므로 실패를 유지한다
    // 어느 쪽이든 `baseline_indeterminate` 로 흔적이 남아 조용히 사라지지 않는다.
    if (shouldReconcileVerifierBaseline(preTaskBaseline)) {
      // Dirty-tree baseline also failed — distinguish pre-existing from
      // task-caused by running the verifier on a clean HEAD checkout.
      // HEAD also fails → truly pre-existing (committed code is broken).
      // HEAD passes → dirty changes caused the failure; the task may have
      // introduced or been affected by them — do not skip verifier.
      const headBaseline = await captureHeadBaseline(task, controllerSignal);
      const reconciledResult = reconcileVerifierBaseline(
        verifierResult,
        baselineForReconciliation(preTaskBaseline),
        headBaseline,
      );
      if (reconciledResult.verifier_skipped) {
        try {
          persistVerifierResult(task.taskId, reconciledResult);
        } catch (persistErr) {
          log.warn({ taskId: task.taskId, err: persistErr }, 'Failed to persist skipped verifier result');
        }
        return classified;
      }

      if (reconciledResult.baseline_indeterminate) {
        log.warn({
          taskId: task.taskId,
          cwd: projectDir,
          command: task.verifier.command,
          preExitCode: preTaskBaseline?.code ?? null,
          // baseline 을 못 잡은 것과 잡았는데 실패한 것은 조치가 다르다. 구분해 남긴다.
          preBaselineCaptured: preTaskBaseline !== null,
          headExitCode: headBaseline?.code ?? null,
          headTimedOut: headBaseline?.timedOut ?? null,
        }, 'baseline_indeterminate: HEAD-clean verifier baseline unavailable or inconclusive');
      } else {
        log.warn({
          taskId: task.taskId,
          cwd: projectDir,
          command: task.verifier.command,
          preExitCode: preTaskBaseline?.code ?? null,
          preBaselineCaptured: preTaskBaseline !== null,
          headExitCode: headBaseline?.code ?? null,
        }, 'HEAD-clean verifier passed — dirty-worktree baseline failure is not pre-existing');
      }

      try {
        persistVerifierResult(task.taskId, reconciledResult);
      } catch (persistErr) {
        log.warn({ taskId: task.taskId, err: persistErr }, 'Failed to persist verifier result');
      }
      return {
        ...classified,
        success: false,
        error: [
          classified.error,
          `verifier failed: ${outputSnippet}`,
          reconciledResult.baseline_indeterminate
            ? `baseline_indeterminate: ${reconciledResult.baseline_indeterminate}`
            : undefined,
        ].filter(Boolean).join('\n\n'),
      };
    }

    try {
      persistVerifierResult(task.taskId, verifierResult);
    } catch (persistErr) {
      log.warn({ taskId: task.taskId, err: persistErr }, 'Failed to persist verifier result');
    }
    return {
      ...classified,
      success: false,
      error: [classified.error, `verifier failed: ${outputSnippet}`].filter(Boolean).join('\n\n'),
    };
  } catch (err) {
    const outputSnippet = String(err instanceof Error ? err.message : err).slice(0, 2000);
    const verifierResult: VerifierResult = {
      type: 'run',
      command: task.verifier.command,
      timeoutMs,
      startedAt,
      exitCode: null,
      timedOut: false,
      passed: false,
      outputSnippet,
      spawnError: outputSnippet,
    };
    try {
      persistVerifierResult(task.taskId, verifierResult);
    } catch (persistErr) {
      log.warn({ taskId: task.taskId, err: persistErr }, 'Failed to persist verifier result');
    }

    return {
      ...classified,
      success: false,
      error: [classified.error, `verifier failed: ${outputSnippet}`].filter(Boolean).join('\n\n'),
    };
  }
}

// ─── In-memory semaphore (Redis-offline fallback) ─────
interface SemaphoreWaiter {
  waiterId?: string;
  resolve: (acquired: boolean) => void;
  previous: SemaphoreWaiter | null;
  next: SemaphoreWaiter | null;
}

export class Semaphore {
  private limit: number;
  private inUse = 0;
  private head: SemaphoreWaiter | null = null;
  private tail: SemaphoreWaiter | null = null;
  private readonly waitersById = new Map<string, Set<SemaphoreWaiter>>();

  constructor(concurrency: number) {
    this.limit = Math.max(1, concurrency);
  }

  async acquire(waiterId?: string): Promise<boolean> {
    if (this.inUse < this.limit) {
      this.inUse++;
      return true;
    }
    return await new Promise<boolean>(resolve => {
      const waiter: SemaphoreWaiter = {
        waiterId,
        resolve,
        previous: this.tail,
        next: null,
      };
      if (this.tail) this.tail.next = waiter;
      else this.head = waiter;
      this.tail = waiter;

      if (waiterId !== undefined) {
        let indexed = this.waitersById.get(waiterId);
        if (!indexed) {
          indexed = new Set();
          this.waitersById.set(waiterId, indexed);
        }
        indexed.add(waiter);
      }
    });
  }

  cancel(waiterId: string): boolean {
    const indexed = this.waitersById.get(waiterId);
    const waiter = indexed?.values().next().value as SemaphoreWaiter | undefined;
    if (!waiter) return false;
    this.unlink(waiter);
    waiter.resolve(false);
    return true;
  }

  cancelAll(): number {
    let cancelled = 0;
    let waiter = this.head;
    this.head = null;
    this.tail = null;
    this.waitersById.clear();
    while (waiter) {
      const next = waiter.next;
      waiter.previous = null;
      waiter.next = null;
      waiter.resolve(false);
      cancelled++;
      waiter = next;
    }
    return cancelled;
  }

  isSaturated(): boolean {
    return this.inUse >= this.limit;
  }

  release(): void {
    this.inUse = Math.max(0, this.inUse - 1);
    this.drain();
  }

  setLimit(concurrency: number): void {
    this.limit = Math.max(1, concurrency);
    this.drain();
  }

  private drain(): void {
    while (this.head && this.inUse < this.limit) {
      const next = this.head;
      this.unlink(next);
      this.inUse++;
      next.resolve(true);
    }
  }

  private unlink(waiter: SemaphoreWaiter): void {
    if (waiter.previous) waiter.previous.next = waiter.next;
    else this.head = waiter.next;
    if (waiter.next) waiter.next.previous = waiter.previous;
    else this.tail = waiter.previous;

    if (waiter.waiterId !== undefined) {
      const indexed = this.waitersById.get(waiter.waiterId);
      indexed?.delete(waiter);
      if (indexed?.size === 0) this.waitersById.delete(waiter.waiterId);
    }
    waiter.previous = null;
    waiter.next = null;
  }
}

// 검증 빌드 게이트 — Semaphore 클래스 선언 이후에 lazy 생성 (TDZ 회피).
let verifierBuildSemaphore: Semaphore | null = null;
function getVerifierBuildSemaphore(): Semaphore {
  if (!verifierBuildSemaphore) {
    verifierBuildSemaphore = new Semaphore(resolveVerifierBuildConcurrency());
  }
  return verifierBuildSemaphore;
}

// ─── Per-agent queue entry ─────────────────────────────
interface AgentQueueEntry {
  queue?: Queue;
  queueEvents?: QueueEvents;
  worker?: Worker;
  semaphore: Semaphore;      // always present as fallback
  configuredConcurrency: number;
  concurrency: number;
  activeControllers: Map<string, AbortController>; // taskId → controller
  mode: 'bullmq' | 'semaphore';
  // For semaphore mode: track waiting/active counts
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  /** False after the provider leaves the committed registry snapshot. */
  accepting: boolean;
  providerType: ProviderConfig['type'];
}

type LivenessState = 'working' | 'stalled' | 'dead';

interface TaskRuntimeEntry {
  taskId: string;
  agentId: string;
  queueAttempt: number;
  controller: AbortController;
  startedAt: number;
  timeoutMs: number;
  idleTimeoutMs: number;
  firstActivityTimeoutMs: number;
  lastActivityAt: number;
  lastOutputAt: number;
  firstOutputAt?: number | null;
  firstActivityObserved: boolean;
  firstOutputObserved: boolean;
  lastDbFlushAt: number;
  partialOutput: string;
  childPid: number | null;
  lastCpuSeconds: number | null;
  processAlive: boolean;
  liveness: LivenessState;
  stalledSince: number | null;
  lastHeartbeatFlushAt: number;
  shutdownSignal?: string;
  abortReason?: 'cancelled' | 'timeout(idle)' | 'timeout(hardcap)' | 'timeout(first-activity)';
  abortedAt?: number;
}

// ─── TaskQueueManager ─────────────────────────────────
export class TaskQueueManager {
  private agents = new Map<string, AgentQueueEntry>();
  /** Last successfully reconciled enabled provider generation. */
  private providerConfigs = new Map<string, ProviderConfig>();
  /** Distinguishes a valid committed empty generation from legacy test setup. */
  private providerViewCommitted = false;
  private executor: TaskExecutor | null = null;
  private initialized = false;
  private shutdownSignal: string | null = null;
  private runtimes = new Map<string, TaskRuntimeEntry>();
  private verifierBaselines = new Map<string, Promise<VerifierProcessResult | null>>();
  private enqueueScopes = new Map<string, number>();
  private enqueueInFlight = new Map<string, Promise<TaskExecutionResult>>();
  private waitingBullMqAborters = new Map<string, () => void>();
  private waitingBullMqJobs = new Map<string, Job<QueuedTask>>();
  /** Detached `/api/agent/start` executions that do not have a tasks row. */
  private externalExecutions = new Map<string, { agentId: string; pid: number | null }>();
  private ownershipHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private ownershipRole: TaskQueueInstanceRole = 'unknown';
  private ownershipState: Exclude<TaskQueueInstanceState, 'stopped'> = 'running';
  private priorityAgingTimer: ReturnType<typeof setInterval> | null = null;
  private priorityAgingInFlight: Promise<void> | null = null;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private queueHygieneInFlight: Promise<QueueHygieneResult> | null = null;
  /** Advanced only after a matching apply pass; previews keep plan scope stable. */
  private retiredQueueDiscoveryCursor = '0';
  private reconcileSerial: Promise<void> = Promise.resolve();

  private getOrCaptureVerifierBaseline(
    task: QueuedTask,
    signal: AbortSignal,
  ): Promise<VerifierProcessResult | null> {
    const existing = this.verifierBaselines.get(task.taskId);
    if (existing) return existing;
    const baseline = captureVerifierBaseline(task, signal);
    this.verifierBaselines.set(task.taskId, baseline);
    return baseline;
  }

  private runPriorityAgingTick(): Promise<void> {
    if (this.priorityAgingInFlight) return this.priorityAgingInFlight;
    const run = (async () => {
      for (const [, entry] of this.agents) {
        if (entry.mode !== 'bullmq' || !entry.queue) continue;
        try {
          const waiting = await listBullQueueWaitingJobs(entry.queue);
          await ageBullQueueWaitingJobs(waiting);
        } catch {
          // Queue shutdown/Redis races are retried on the next tick.
        }
      }
    })();
    this.priorityAgingInFlight = run.finally(() => {
      this.priorityAgingInFlight = null;
    });
    return this.priorityAgingInFlight;
  }

  private getEffectiveConcurrency(agentId: string, configuredConcurrency: number): number {
    const configured = Math.max(1, configuredConcurrency);
    if (configured <= 1 || !DYNAMIC_LOCAL_CONCURRENCY_IDS.has(agentId)) {
      return configured;
    }

    const snapshot = circuitBreakerRegistry.getSnapshot(agentId);
    return snapshot.state === 'closed' ? configured : 1;
  }

  private refreshEntryConcurrency(agentId: string, entry: AgentQueueEntry): number {
    const effective = this.getEffectiveConcurrency(agentId, entry.configuredConcurrency);
    entry.concurrency = effective;
    entry.semaphore.setLimit(effective);
    if (entry.worker) entry.worker.concurrency = effective;
    return effective;
  }

  private providerUnavailable(agentId: string): TaskExecutionResult {
    return {
      success: false,
      output: '',
      error: `provider_unavailable: ${agentId} is not registered in the current provider snapshot`,
      status: 'failed',
    };
  }

  /**
   * Older embedded tests call private execution helpers with a hand-built entry
   * before any registry generation exists. Once reconcileProviders has marked
   * an entry, only the committed provider map can admit it.
   */
  private entryAccepts(agentId: string, entry: AgentQueueEntry): boolean {
    const accepting = (entry as AgentQueueEntry & { accepting?: boolean }).accepting;
    if (accepting === false) return false;
    if (!this.providerViewCommitted) return true;
    return accepting === true && this.providerConfigs.has(agentId);
  }

  private currentProviderIds(): string[] {
    if (this.providerViewCommitted) return [...this.providerConfigs.keys()];
    return [...this.agents.entries()]
      .filter(([, entry]) => entry.accepting !== false)
      .map(([agentId]) => agentId);
  }

  private currentProviderConfigs(): ProviderConfig[] {
    if (this.providerViewCommitted) return [...this.providerConfigs.values()];
    const ids = new Set(this.currentProviderIds());
    return registeredProviders().filter(provider => provider.enabled && ids.has(provider.id));
  }

  private currentProviderConfig(agentId: string): ProviderConfig | undefined {
    const committed = this.providerConfigs.get(agentId);
    if (committed) return committed;
    if (this.providerViewCommitted) return undefined;
    return registeredProviders().find(provider => provider.enabled && provider.id === agentId);
  }

  private resolveTaskModelForAgent(
    task: QueuedTask,
    metadata: Record<string, unknown>,
    agentId: string,
  ): QueuedTaskModelResolution | null {
    const provider = this.currentProviderConfig(agentId);
    if (!provider) {
      const merged = { ...(task.metadata ?? {}), ...metadata };
      const hasModelContract = Boolean(
        (typeof task.model === 'string' && task.model.trim())
        || nonEmptyMetadataString(merged, 'model')
        || nonEmptyMetadataString(merged, 'requestedModel')
        || nonEmptyMetadataString(merged, 'modelSelection')
        || nonEmptyMetadataString(merged, 'modelTaskType'),
      );
      if (hasModelContract) {
        throw new QueueModelResolutionError(agentId, 'provider catalog entry is unavailable');
      }
      // Legacy embedded tests can invoke queue helpers before a provider
      // generation is committed. Preserve that no-model behavior only when
      // there is no model contract to validate.
      return null;
    }
    return resolveQueuedTaskModelForProvider(
      { ...task, metadata: { ...(task.metadata ?? {}), ...metadata } },
      provider,
      metadata,
    );
  }

  private taskModelCompatibleWithAgent(
    task: QueuedTask,
    metadata: Record<string, unknown>,
    agentId: string,
  ): boolean {
    try {
      this.resolveTaskModelForAgent(task, metadata, agentId);
      return true;
    } catch (error) {
      log.warn({
        taskId: task.taskId,
        agentId,
        error: error instanceof Error ? error.message : String(error),
      }, 'Skipping provider that cannot satisfy the task model contract');
      return false;
    }
  }

  /**
   * Register the function that actually runs a task.
   * Called once during boot with agentManager.executeTask.
   */
  setExecutor(fn: TaskExecutor): void {
    this.executor = fn;
  }

  beginShutdown(signal: string): void {
    this.shutdownSignal ??= signal;
    this.ownershipState = 'draining';
    try {
      markTaskQueueInstanceDraining(getDb());
    } catch (error) {
      log.warn({
        error: error instanceof Error ? error.message : String(error),
      }, 'Task queue draining state update failed');
    }
    for (const runtime of this.runtimes.values()) {
      runtime.shutdownSignal ??= this.shutdownSignal;
    }
  }

  startOwnershipHeartbeat(role: TaskQueueInstanceRole): void {
    this.ownershipRole = role;
    this.heartbeatOwnership();
    if (this.ownershipHeartbeatTimer) return;
    this.ownershipHeartbeatTimer = setInterval(() => {
      this.heartbeatOwnership();
    }, TASK_QUEUE_INSTANCE_HEARTBEAT_MS);
    this.ownershipHeartbeatTimer.unref?.();
  }

  private heartbeatOwnership(): void {
    try {
      const db = getDb();
      if (!heartbeatTaskQueueInstance(db, {
        role: this.ownershipRole,
        state: this.ownershipState,
      })) return;
      if (!taskQueueOwnershipColumnsAvailable(db)) return;
      const expiresAt = sqliteUtcAfter(Date.now(), resolveQueueOwnershipLeaseMs());
      const executorColumn = taskQueueExecutorColumnAvailable(db);
      db.prepare(`
        UPDATE tasks
        SET queue_expires_at=?
        WHERE status NOT IN ('completed','failed','timed_out','cancelled','lease_expired')
          AND (
            queue_owner_instance_id=?
            ${executorColumn ? 'OR queue_executor_instance_id=?' : ''}
          )
      `).run(
        expiresAt,
        TASK_QUEUE_OWNER_INSTANCE_ID,
        ...(executorColumn ? [TASK_QUEUE_OWNER_INSTANCE_ID] : []),
      );
    } catch (error) {
      log.warn({
        error: error instanceof Error ? error.message : String(error),
      }, 'Task queue ownership heartbeat failed');
    }
  }

  registerExternalExecution(executionId: string, agentId: string): void {
    this.externalExecutions.set(executionId, { agentId, pid: null });
  }

  unregisterExternalExecution(executionId: string): void {
    const execution = this.externalExecutions.get(executionId);
    this.externalExecutions.delete(executionId);
    if (execution?.pid != null) {
      unregisterRuntimeSessionProcess(executionId, getDb(), execution.pid);
    }
  }

  /**
   * Initialize queues for all enabled providers.
   * Safe to call even if Redis is offline — falls back to semaphore mode.
   */
  async init(providers: readonly ProviderConfig[]): Promise<void> {
    if (!this.initialized) {
      this.initialized = true;
      if (!this.ownershipHeartbeatTimer) this.startOwnershipHeartbeat(this.ownershipRole);

      this.priorityAgingTimer = setInterval(() => {
        void this.runPriorityAgingTick();
      }, 60_000);
      this.priorityAgingTimer.unref?.();

      this.monitorTimer = setInterval(() => {
        for (const runtime of this.runtimes.values()) this.monitorRuntime(runtime);
      }, TASK_MONITOR_INTERVAL_MS);
      this.monitorTimer.unref?.();
    }

    await this.reconcileProviders(providers);
  }

  /**
   * Prepare new queue resources, then synchronously publish one admission view.
   * Removed providers reject new work; already-running executions retain their
   * captured entry and drain without receiving an AbortSignal.
   */
  async reconcileProviders(providers: readonly ProviderConfig[]): Promise<void> {
    const enabled = providers
      .filter(provider => provider.enabled !== false)
      .map(provider => structuredClone(provider));
    const ids = new Set<string>();
    for (const provider of enabled) {
      if (ids.has(provider.id)) {
        throw new Error(`provider_snapshot_invalid: duplicate provider id ${provider.id}`);
      }
      ids.add(provider.id);
    }

    const operation = this.reconcileSerial.then(async () => {
      const nextConfigs = new Map(enabled.map(provider => [provider.id, provider]));
      const staged = new Map<string, AgentQueueEntry>();
      const redisAvailable = isRedisConnected();

      for (const provider of enabled) {
        if (this.agents.has(provider.id)) continue;
        const concurrency = Math.max(1, provider.concurrency ?? 1);
        const effectiveConcurrency = this.getEffectiveConcurrency(provider.id, concurrency);
        const entry: AgentQueueEntry = {
          semaphore: new Semaphore(effectiveConcurrency),
          configuredConcurrency: concurrency,
          concurrency: effectiveConcurrency,
          activeControllers: new Map(),
          mode: 'semaphore',
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          accepting: false,
          providerType: provider.type,
        };
        if (redisAvailable) {
          try {
            await this.setupBullMQ(provider.id, effectiveConcurrency, entry);
            entry.mode = 'bullmq';
          } catch (error) {
            log.warn({
              agentId: provider.id,
              err: error instanceof Error ? error.message : String(error),
            }, 'BullMQ init failed — falling back to semaphore');
          }
        }
        staged.set(provider.id, entry);
      }

      // No await below: admission flags and authoritative configs change as
      // one event-loop transaction.
      for (const [agentId, entry] of this.agents) {
        const provider = nextConfigs.get(agentId);
        if (!provider) {
          entry.accepting = false;
          continue;
        }
        entry.providerType = provider.type;
        entry.configuredConcurrency = Math.max(1, provider.concurrency ?? 1);
        entry.accepting = true;
        this.refreshEntryConcurrency(agentId, entry);
      }
      for (const [agentId, entry] of staged) {
        entry.accepting = true;
        this.agents.set(agentId, entry);
      }
      this.providerConfigs = nextConfigs;
      this.providerViewCommitted = true;
      log.info({
        providers: [...nextConfigs.keys()],
        added: [...staged.keys()],
        removed: [...this.agents.entries()]
          .filter(([, entry]) => !entry.accepting)
          .map(([agentId]) => agentId),
      }, 'Task queue provider snapshot reconciled');
    });

    this.reconcileSerial = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async setupBullMQ(agentId: string, concurrency: number, entry: AgentQueueEntry): Promise<void> {
    const redis = await getRedis();
    const connection = { host: redis.options.host || '127.0.0.1', port: Number(redis.options.port || 6379) };
    const queueName = `nco-agent-${agentId}`;
    const prefix = resolveBullMqPrefix();

    // The marker survives provider retirement and gives later hygiene passes
    // exact queue ownership evidence without relying only on a name pattern.
    await markNcoBullMqQueueOwnership(redis, prefix, queueName);
    entry.queue = new Queue<QueuedTask>(queueName, { connection, prefix });
    entry.queueEvents = new QueueEvents(queueName, { connection, prefix });
    await this.purgeStaleJobs(entry.queue);

    entry.worker = new Worker<QueuedTask>(
      queueName,
      async (job: Job<QueuedTask>) => {
        return this.runJob(job.data, entry, job);
      },
      {
        connection,
        prefix,
        concurrency,
        // BullMQ 기본 30초는 짧지만 hard timeout 전체(20분)만큼 잡을 필요는 없다.
        // live worker는 lock을 갱신하므로 장기 작업도 유지되고, worker crash 시에는
        // 이 상한 뒤 stalled recovery가 용량을 회수한다.
        lockDuration: BULLMQ_LOCK_DURATION_MS,
        stalledInterval: 60_000,
        maxStalledCount: 3,
      },
    );

    log.debug({ agentId, concurrency }, 'BullMQ queue+worker created');
  }

  private async runJob(
    task: QueuedTask,
    entry: AgentQueueEntry,
    bullJob?: Job<QueuedTask>,
  ): Promise<TaskExecutionResult> {
    if (providerGenerationGate.isTransitioning()) {
      await providerGenerationGate.waitUntilStable();
    }
    if (!this.executor) throw new Error('Executor not set');
    if (!this.entryAccepts(task.agentId, entry)) {
      return this.providerUnavailable(task.agentId);
    }
    if (!isProviderQualified(task.agentId)) {
      if (bullJob) {
        const retryMs = Math.max(1_000, Number(process.env.NCO_PROVIDER_QUALIFICATION_RETRY_MS) || 30_000);
        const requestedQueueWaitMs = Number(task.metadata?.queueWaitMaxMs);
        const queueWaitMaxMs = Number.isFinite(requestedQueueWaitMs) && requestedQueueWaitMs > 0
          ? requestedQueueWaitMs
          : DEFAULT_QUEUE_WAIT_MAX_MS;
        const queueDeadline = bullJob.timestamp + queueWaitMaxMs;
        if (Date.now() + retryMs < queueDeadline) {
          await bullJob.moveToDelayed(Date.now() + retryMs, bullJob.token);
          throw new DelayedError();
        }
      }
      return this.providerUnavailable(task.agentId);
    }

    this.refreshEntryConcurrency(task.agentId, entry);
    const acquired = await this.withQueueWaitLeaseRenewal(task, () => entry.semaphore.acquire(task.taskId));
    if (!acquired) {
      return { success: false, output: '', error: 'cancelled', status: 'cancelled' };
    }
    if (!this.entryAccepts(task.agentId, entry)) {
      entry.semaphore.release();
      return this.providerUnavailable(task.agentId);
    }

    const controller = new AbortController();
    try {
      this.startRuntime(task, controller);
    } catch (err) {
      // startRuntime can throw (P1-1 duplicate-execution guard) before the runtime is
      // registered — release the slot we already acquired or it leaks permanently.
      entry.semaphore.release();
      throw err;
    }
    entry.activeControllers.set(task.taskId, controller);
    entry.active++;

    const invocationId = task.metadata?.invocationId as string | undefined;
    try {
      // Invocation persistence is SQLite-backed and can throw BUSY/LOCKED after
      // the runtime, controller, active counter, and semaphore slot are owned.
      // Keep it inside the execution lifecycle so every acquired resource is
      // released even when auxiliary invocation tracking is unavailable.
      if (invocationId) {
        invocationTracker.startInvocation(invocationId);
      }
      const verifierBaseline = await this.getOrCaptureVerifierBaseline(task, controller.signal);
      const result = await this.executor(task, controller.signal);
      const finalized = this.finalizeRuntime(task.taskId, result);
      const classified = classifyResult(finalized);
      const gated = await applyVerifierGate(task, classified, controller.signal, verifierBaseline);
      const terminal = this.applyRuntimeMetadata(task.taskId, gated, finalized);
      // P2-10 pa-lifecycle: 에이전트 사용 기록(웜 유지/축출 결정 근거). sticky는 cold-start 절감.
      paLifecycle.markUsed(task.agentId, Date.now());
      if (invocationId) {
        const summary = (terminal.output || '').slice(0, 2000);
        invocationTracker.completeInvocation(
          invocationId,
          terminal.success ? 'completed' : 'failed',
          terminal.success ? summary : undefined,
          terminal.success ? undefined : (terminal.error || terminal.output),
          terminal.usage,
        );
        await invocationTracker.notifyCompletion(invocationId);
      }
      return terminal;
    } catch (err: any) {
      const finalized = this.finalizeRuntime(task.taskId, {
        success: false,
        output: '',
        error: err?.message || 'unknown: execution failed',
        status: 'failed',
      });
      if (invocationId) {
        invocationTracker.completeInvocation(invocationId, 'failed', undefined, finalized.error || err?.message);
        await invocationTracker.notifyCompletion(invocationId);
      }
      throw new Error(finalized.error || err?.message || 'unknown: execution failed');
    } finally {
      try {
        await this.finishTaskExecution(task);
      } finally {
        // Durable fence cleanup is SQLite-backed too. It must never prevent
        // process-local capacity from being returned to the provider queue.
        entry.activeControllers.delete(task.taskId);
        entry.active = Math.max(0, entry.active - 1);
        entry.semaphore.release();
        // Jobs preserved across a restart can run without a local enqueue()
        // waiter. They have no retry scope in this process, so release their
        // baseline after the worker finishes.
        if (!this.enqueueScopes.has(task.taskId)) {
          this.verifierBaselines.delete(task.taskId);
        }
      }
    }
  }

  /**
   * Enqueue a task with automatic retry on rate limit errors.
   *
   * Retry strategy:
   *   1. Exponential backoff on same agent (up to MAX_RETRIES)
   *   2. If still failing after retries, failover to next available agent
   *
   * The taskId is stable across retries so the DB record stays consistent.
   */
  async enqueue(task: QueuedTask): Promise<TaskExecutionResult> {
    if (providerGenerationGate.isTransitioning()) {
      await providerGenerationGate.waitUntilStable();
    }
    const inFlight = this.enqueueInFlight.get(task.taskId);
    if (inFlight) return inFlight;
    if (this.shutdownSignal) {
      return {
        success: false,
        output: '',
        error: `${GRACEFUL_SHUTDOWN_INTERRUPTION} (${this.shutdownSignal})`,
        status: 'cancelled',
      };
    }

    const execution = (async () => {
      this.enqueueScopes.set(task.taskId, (this.enqueueScopes.get(task.taskId) ?? 0) + 1);
      try {
        return await this.enqueueWithRetries(task);
      } finally {
        const remaining = (this.enqueueScopes.get(task.taskId) ?? 1) - 1;
        if (remaining <= 0) {
          this.enqueueScopes.delete(task.taskId);
          this.verifierBaselines.delete(task.taskId);
        } else {
          this.enqueueScopes.set(task.taskId, remaining);
        }
      }
    })();
    this.enqueueInFlight.set(task.taskId, execution);
    try {
      return await execution;
    } catch (error) {
      const duplicate = duplicateExecutionResultFromError(error);
      if (duplicate) return duplicate;
      throw error;
    } finally {
      if (this.enqueueInFlight.get(task.taskId) === execution) {
        this.enqueueInFlight.delete(task.taskId);
      }
    }
  }

  private prepareQueueAttempt(
    task: QueuedTask,
    metadata: Record<string, unknown>,
    requestedAgentId: string,
    requestedAttempt: number,
    expectedPrevious?: QueueAttemptAdvanceExpectation,
  ): {
    task: QueuedTask;
    metadata: Record<string, unknown>;
    agentId: string;
    attempt: number;
  } {
    let modelResolution: QueuedTaskModelResolution | null = null;
    const persisted = persistTaskQueueAttempt(
      task.taskId,
      requestedAttempt,
      requestedAgentId,
      expectedPrevious,
      (agentId, durableMetadata) => {
        modelResolution = this.resolveTaskModelForAgent(
          task,
          { ...metadata, ...durableMetadata },
          agentId,
        );
        return modelResolution?.metadataPatch ?? {};
      },
    );
    const resolved = modelResolution as QueuedTaskModelResolution | null;
    const nextMetadata = {
      ...metadata,
      ...persisted.metadata,
      ncoQueueAttempt: persisted.attempt,
      ncoQueueAttemptAgentId: persisted.agentId,
    };
    return {
      task: {
        ...task,
        agentId: persisted.agentId,
        // `model` on QueuedTask is the executor override channel. The durable
        // canonical/default model remains in metadata for observability and
        // failover recomputation, but must not become a literal CLI --model.
        ...(resolved ? { model: resolved.executorModel } : {}),
        metadata: nextMetadata,
      },
      metadata: nextMetadata,
      agentId: persisted.agentId,
      attempt: persisted.attempt,
    };
  }

  private async enqueueWithRetries(task: QueuedTask): Promise<TaskExecutionResult> {
    let lastError = '';
    let currentAgentId = task.agentId;
    let currentMetadata: Record<string, unknown> = { ...(task.metadata ?? {}) };
    // task.metadata는 BullMQ job data 스냅샷이라 enqueue 시점에 동결된다. 중첩
    // escalation/failover 스코프에서는 DB가 더 최신이므로 시도이력만 합집합으로 시딩한다
    // (나머지 필드는 스냅샷 우선 유지 — 기존 동작 보존). 롤백: NCO_ATTEMPT_HISTORY_MONOTONIC=0
    if (attemptHistoryMonotonicEnabled()) {
      currentMetadata.attemptedAgents = mergeAttemptedAgents(
        loadTaskMetadata(task.taskId).attemptedAgents,
        getAttemptedAgents(currentMetadata, task.agentId),
      );
    }
    let attemptedAgents = getAttemptedAgents(currentMetadata, task.agentId);
    let stallRetried = false;
    let teamRetried = false;   // P11: 팀 transient failover는 태스크당 1회만
    let retryAfterRateLimit = false;
    const allowStallRetry = process.env.NCO_STALL_RETRY !== '0';
    const p11FailoverEnabled = process.env.NCO_P11_FAILOVER_ENABLED !== '0';
    const durableAttempt = loadTaskMetadata(task.taskId).ncoQueueAttempt;
    let nextQueueAttempt = normalizeQueueAttempt(durableAttempt ?? currentMetadata.ncoQueueAttempt);
    let advanceExpectation: QueueAttemptAdvanceExpectation | undefined;

    for (let localAttempt = 0; localAttempt <= MAX_RETRIES; localAttempt++) {
      // 팀 failover/idle retry의 continue도 attempt를 증가시킨다. 직전 실패가 실제
      // rate-limit일 때만 backoff와 제한 마킹을 적용해 새 가용 후보를 오염시키지 않는다.
      if (localAttempt > 0 && retryAfterRateLimit) {
        retryAfterRateLimit = false;
        const backoffMs = BASE_BACKOFF_MS * Math.pow(2, localAttempt - 1);
        log.info({ taskId: task.taskId, agentId: currentAgentId, attempt: nextQueueAttempt, backoffMs }, 'Rate limit retry');
        this.markRateLimited(currentAgentId);
        await new Promise(r => setTimeout(r, backoffMs));

        // Try to failover after first retry
        if (localAttempt >= 2) {
          const failover = allowGenericProviderFailover(currentMetadata)
            ? this.findFailoverAgent(
                currentAgentId,
                task.agentId,
                attemptedAgents,
                task,
                currentMetadata,
              )
            : null;
          if (failover) {
            log.info({ taskId: task.taskId, from: currentAgentId, to: failover }, 'Failing over to alternate agent');
            const previousAgentId = currentAgentId;
            currentAgentId = failover;
            attemptedAgents = appendAttemptedAgent(attemptedAgents, failover);
            currentMetadata = persistTaskReassignment(
              task.taskId,
              previousAgentId,
              failover,
              { attemptedAgents },
              advanceExpectation
                ? { ...advanceExpectation, nextAttempt: nextQueueAttempt }
                : undefined,
            );
            advanceExpectation = undefined;
          }
        }
      }

      if (isCircuitCooldownWaitEnabled()) {
        const cooldownWaitMs = computeCircuitCooldownWaitMs(currentAgentId);
        if (cooldownWaitMs > 0) {
          log.info(
            { taskId: task.taskId, agentId: currentAgentId, cooldownWaitMs },
            'Deferring task until provider circuit cooldown elapses',
          );
          await new Promise(resolve => setTimeout(resolve, cooldownWaitMs));
        }
      }

      let result: TaskExecutionResult;
      try {
        const prepared = this.prepareQueueAttempt(
          task,
          currentMetadata,
          currentAgentId,
          nextQueueAttempt,
          advanceExpectation,
        );
        advanceExpectation = undefined;
        currentAgentId = prepared.agentId;
        currentMetadata = prepared.metadata;
        attemptedAgents = getAttemptedAgents(currentMetadata, task.agentId);
        nextQueueAttempt = prepared.attempt + 1;
        result = await this.runEnqueue(prepared.task);
        advanceExpectation = {
          attempt: prepared.attempt,
          agentId: prepared.agentId,
          status: 'running',
        };
      } catch (error) {
        const duplicate = duplicateExecutionResultFromError(error);
        if (duplicate) return duplicate;
        throw error;
      }

      if (result.success) return result;
      // BullMQ waitUntilFinished() surfaces an UnrecoverableError as a failed result.
      // Do not turn the blocked duplicate into an enqueue-loop retry or escalation.
      if (isDuplicateExecutionFailure(result)) {
        return isTaskExecutionJoinOutcome(result)
          ? result
          : {
              ...result,
              queueOutcome: /\(duplicate_attempt\)/.test(result.error ?? '')
                ? 'joined'
                : 'deduplicated',
            };
      }
      // A cancellation is terminal. In particular, graceful-shutdown SIGINT
      // normalization must not fall through to tier escalation and start a new
      // provider while the process is draining.
      if (result.status === 'cancelled') return result;

      // ── P11: 팀 위임 transient 실패 → 팀 실행자 체인 다음 후보로 1회 재시도(team-aware) ──
      // company-orchestrator 파이프라인의 stage-failover(P5)를 단일 팀 위임(/api/task 직행)에도 부여.
      // 정상완료·사용자취소·rate-limit은 isTransientFailure에서 이미 배제 → 오탐 없음.
      // 비활성화: NCO_P11_FAILOVER_ENABLED=0
      if (
        p11FailoverEnabled
        && allowGenericProviderFailover(currentMetadata)
        && !teamRetried
        && (
          isTransientFailure(result)
          || isEvolutionLearningTaskRecoverableFailure(task.taskId, result)
        )
      ) {
        const known = new Set(this.currentProviderIds());
        const next = await nextTeamExecutor(
          task.taskId,
          known,
          attemptedAgents,
          async candidate => (
            this.taskModelCompatibleWithAgent(task, currentMetadata, candidate)
            && await providerModelDispatchable(candidate)
          ),
        );
        if (next && next !== currentAgentId) {
          teamRetried = true;
          const previousAgentId = currentAgentId;
          currentAgentId = next;
          attemptedAgents = appendAttemptedAgent(attemptedAgents, next);
          currentMetadata = persistTaskReassignment(
            task.taskId,
            previousAgentId,
            next,
            { attemptedAgents },
            advanceExpectation
              ? { ...advanceExpectation, nextAttempt: nextQueueAttempt }
              : undefined,
          );
          advanceExpectation = undefined;
          log.warn(
            { taskId: task.taskId, from: previousAgentId, to: next, reason: result.error },
            'P11 team transient failover — retrying once with next chain executor',
          );
          continue; // 다음 루프 반복에서 next 실행자로 runEnqueue 재실행
        }
      }

      if (!stallRetried && allowStallRetry && result.error === 'timeout(idle)') {
        stallRetried = true;
        log.warn({ taskId: task.taskId, agentId: currentAgentId }, 'Idle-timeout task will be retried once');
        continue;
      }

      // Check if failure was rate limit related
      const errMsg = result.error || result.output || '';
      if (!isRateLimitError(errMsg)) {
        // Non-rate-limit failure — don't retry same agent, but try tier escalation
        // (소형모델의 '잘못된 출력' 실패가 가장 흔한 케이스 — rate-limit 경로만 타면 에스컬레이션이 영영 안 걸림)
        const escalated = await this.tryTierEscalation(
          task,
          currentAgentId,
          errMsg,
          attemptedAgents,
          currentMetadata,
          'non-rate-limit failure',
          nextQueueAttempt,
        );
        if (escalated) return escalated;
        return result;
      }

      if (isHardQuotaError(errMsg)) {
        // Monthly/weekly/account quota cannot recover during 5/10/20-second
        // backoff. Fail closed immediately when failover is forbidden; when it
        // is allowed, move straight to another provider without sleeping or
        // re-running the exhausted account.
        this.markRateLimited(currentAgentId, true);
        const escalated = await this.tryTierEscalation(
          task,
          currentAgentId,
          errMsg,
          attemptedAgents,
          currentMetadata,
          'hard quota',
          nextQueueAttempt,
        );
        if (escalated) return escalated;
        log.warn(
          { taskId: task.taskId, agentId: currentAgentId },
          'Provider hard quota — terminating without unrecoverable backoff',
        );
        return result;
      }

      lastError = errMsg;
      retryAfterRateLimit = true;
      log.warn({ taskId: task.taskId, agentId: currentAgentId, attempt: nextQueueAttempt - 1 }, 'Rate limit hit — will retry');
    }

    const escalated = await this.tryTierEscalation(
      task,
      currentAgentId,
      lastError,
      attemptedAgents,
      currentMetadata,
      'rate limit exhaustion',
      nextQueueAttempt,
    );
    if (escalated) return escalated;

    return { success: false, output: '', error: `Rate limit exhausted after ${MAX_RETRIES} retries: ${lastError}` };
  }

  /**
   * decideFinalEscalation을 실행하고 escalate 판정 시 다음 tier 에이전트로 재큐잉.
   * escalate가 아니거나 결정 실패 시 null 반환(호출측이 기존 실패 경로 유지).
   */
  private async tryTierEscalation(
    task: QueuedTask,
    failedAgentId: string,
    failureReason: string,
    attemptedAgents: string[],
    currentMetadata: Record<string, unknown>,
    context: string,
    queueAttempt: number,
  ): Promise<TaskExecutionResult | null> {
    if (!allowGenericProviderFailover(currentMetadata)) return null;
    try {
      const teamId = loadTaskTeamId(task.taskId) ?? currentMetadata.teamId;
      const knownAgents = filterActivelyRateLimitedAgents(
        filterCommanderLaneEscalationAgents(
          filterEvolutionSkillsEscalationAgents(
            teamId,
            filterRecoveryCheckpointEscalationAgents(teamId, this.currentProviderIds()),
          ),
        ),
      ).filter(agentId => this.taskModelCompatibleWithAgent(task, currentMetadata, agentId));
      const escalation = decideFinalEscalation({
        failedAgentId,
        failureReason,
        attemptedAgents,
        // P0-4: 원시 state 비교는 half-open을 배제하지 못해(half-open은 'open'이 아니므로
        // 통과) 고착 좀비가 에스컬레이션으로 흘러 실패를 증폭시켰다(CB 실패의 79.1%가 이 경로).
        // getAvailability().available로 half-open/probe까지 일관되게 판정한다
        // (코드베이스 나머지 20곳과 동일한 기준 — 이 줄이 유일한 이탈 지점이었다).
        circuitOpenAgents: circuitBreakerRegistry
          .listSnapshots()
          .filter(snapshot => !circuitBreakerRegistry.getAvailability(snapshot.agentId).available)
          .map(snapshot => snapshot.agentId),
        // 런타임 등록 에이전트로 후보 제한 — 정적 tier의 미등록 항목 배제
        // 에스컬레이션 방지 (2026-07-10 T1: Unknown agent 연쇄 실패 4건)
        knownAgents,
        metadata: currentMetadata,
      });
      if (escalation.action === 'escalate' && escalation.nextAgentId && escalation.metadataPatch) {
        const nextMetadata = persistTaskReassignment(
          task.taskId,
          failedAgentId,
          escalation.nextAgentId,
          escalation.metadataPatch,
          {
            attempt: queueAttempt - 1,
            nextAttempt: queueAttempt,
            agentId: failedAgentId,
            status: 'running',
          },
        );
        recordLearningEvent({
          agentId: escalation.nextAgentId,
          eventType: 'escalation',
          pattern: escalation.reason,
          context: {
            taskId: task.taskId,
            fromAgent: failedAgentId,
            toAgent: escalation.nextAgentId,
            context,
          },
        });
        log.info({
          taskId: task.taskId,
          from: failedAgentId,
          to: escalation.nextAgentId,
          reason: escalation.reason,
        }, `Escalating task after ${context}`);
        const prepared = this.prepareQueueAttempt(
          task,
          nextMetadata,
          escalation.nextAgentId,
          queueAttempt,
        );
        return await this.runEnqueue(prepared.task);
      }
    } catch (err) {
      const duplicate = duplicateExecutionResultFromError(err);
      if (duplicate) return duplicate;
      log.warn({ taskId: task.taskId, err: err instanceof Error ? err.message : String(err) }, `Escalation decision failed after ${context}`);
    }
    return null;
  }

  /** Mark an agent as rate-limited in the DB so smart-router skips it */
  private markRateLimited(agentId: string, hardQuota = false): void {
    try {
      const db = getDb();
      const now = Date.now();
      let resetAtMs = now + (hardQuota ? 60 * 60_000 : 60_000);
      if (hardQuota) {
        // AgentManager records the provider failure before TaskQueue receives
        // the result. Reuse its parsed quota reset (for example Claude's
        // "resets 4am (Asia/Seoul)") and retain a bounded one-hour fallback
        // when no absolute reset was supplied.
        try {
          const snapshot = circuitBreakerRegistry.getSnapshot(agentId);
          if (
            snapshot.reason === 'quota'
            && snapshot.cooldownUntil != null
            && snapshot.cooldownUntil > now
          ) {
            resetAtMs = snapshot.cooldownUntil;
          }
        } catch { /* persist the one-hour fallback even if circuit state is unavailable */ }
      }
      const resetAt = new Date(resetAtMs).toISOString();
      db.prepare(`
        INSERT INTO rate_limit_state (agent_id, is_limited, reset_at, updated_at)
        VALUES (?, 1, ?, datetime('now'))
        ON CONFLICT(agent_id) DO UPDATE SET
          is_limited=1,
          reset_at=CASE
            WHEN datetime(rate_limit_state.reset_at) > datetime(excluded.reset_at)
              THEN rate_limit_state.reset_at
            ELSE excluded.reset_at
          END,
          updated_at=datetime('now')
      `).run(agentId, resetAt);
    } catch { /* table may not exist yet */ }
  }

  /** Find an available agent to failover to */
  private findFailoverAgent(
    currentAgentId: string,
    originalAgentId: string,
    attemptedAgents: string[] = [],
    task?: QueuedTask,
    metadata: Record<string, unknown> = {},
  ): string | null {
    const providers = this.currentProviderConfigs();
    // Prefer free/local agents, but never route to an attempted, unavailable,
    // unregistered, or rate-limited provider.
    try {
      const attempted = new Set(attemptedAgents);
      const eligible = new Set(filterActivelyRateLimitedAgents(
        providers.map(provider => provider.id),
      ));

      const candidates = providers
        .filter(p => (
          p.id !== currentAgentId
          && p.id !== originalAgentId
          && !attempted.has(p.id)
          && this.agents.get(p.id)?.accepting !== false
          && eligible.has(p.id)
          && isProviderQualified(p.id)
          && circuitBreakerRegistry.getAvailability(p.id).available
          && (!task || this.taskModelCompatibleWithAgent(task, metadata, p.id))
        ))
        .sort((a, b) => {
          // Free agents first
          if (a.cost === 'free' && b.cost !== 'free') return -1;
          if (b.cost === 'free' && a.cost !== 'free') return 1;
          return 0;
        });

      return candidates[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Internal: actually enqueue to BullMQ or semaphore (no retry logic).
   */
  private async runEnqueue(task: QueuedTask): Promise<TaskExecutionResult> {
    const entry = this.agents.get(task.agentId);
    if (!entry || !this.entryAccepts(task.agentId, entry) || !isProviderQualified(task.agentId)) {
      return this.providerUnavailable(task.agentId);
    }

    if (entry.mode === 'bullmq' && entry.queue) {
      return this.enqueueBullMQ(task, entry);
    }
    return this.enqueueSemaphore(task, entry);
  }

  private async enqueueBullMQ(task: QueuedTask, entry: AgentQueueEntry): Promise<TaskExecutionResult> {
    if (!this.entryAccepts(task.agentId, entry)) {
      return this.providerUnavailable(task.agentId);
    }
    const requestedQueuePriority = Number(task.metadata?.queuePriority);
    const queuePriority = Number.isInteger(requestedQueuePriority)
      && requestedQueuePriority >= 0
      && requestedQueuePriority <= 2_097_152
      ? requestedQueuePriority
      : task.priority ?? 5;
    const jobId = resolveBullMqJobId(task.taskId, task.metadata?.ncoQueueAttempt);
    // Queue.add() is atomic on jobId. All gateway processes therefore join the
    // same logical attempt, while the next bounded retry uses a different ID.
    // No retained job is deleted or reprocessed, eliminating both cached-result
    // replay and remove/retry generation races.
    const job = await entry.queue!.add(task.taskId, task, {
      jobId,
      removeOnComplete: 100,
      removeOnFail: 50,
      priority: queuePriority,
      // 재시도·에스컬레이션은 enqueue()의 단일 루프가 담당한다. BullMQ까지 재시도하면
      // 동일 taskId가 이중 실행되고 terminal 결과가 매몰될 수 있다.
      attempts: BULLMQ_JOB_ATTEMPTS,
    });
    entry.waiting++;
    let leftWaiting = false;

    try {
      const requestedQueueWaitMs = Number(task.metadata?.queueWaitMaxMs);
      const queueWaitMaxMs = Number.isFinite(requestedQueueWaitMs) && requestedQueueWaitMs > 0
        ? Math.min(requestedQueueWaitMs, this.getQueueWaitMaxMs())
        : this.getQueueWaitMaxMs();
      await this.waitForJobActive(job, entry.queueEvents!, queueWaitMaxMs);
      entry.waiting = Math.max(0, entry.waiting - 1);
      leftWaiting = true;
      const result = await job.waitUntilFinished(
        entry.queueEvents!,
        this.getBullWaitTimeoutMs(task.timeoutMs),
      ) as { success: boolean; output: string };
      // 실행 실패는 예외가 아니라 success:false 객체로 온다. 무조건 completed++ 하면
      // 아래 catch 는 진짜 예외에서만 도니 실패가 성공으로 계상된다(실측 2026-08-05:
      // codex 큐 655완료·0실패 vs DB 9완료·28실패). 세마포어 경로(:4503)는 이미
      // success 로 분기하므로 그쪽과 의미를 맞춘다. 취소를 별도 카테고리로 두지 않는
      // 이유는 취소 사유가 기기마다 다르고 상당수가 error NULL 로 불명이기 때문이다.
      if (result.success) entry.completed++;
      else entry.failed++;
      return result;
    } catch (err: any) {
      // waiting 감소는 대기 이탈 시 1회만 — active 진입 후 실행 실패에서 이중 감소 금지 (리뷰 MED)
      if (!leftWaiting) entry.waiting = Math.max(0, entry.waiting - 1);
      const error = err instanceof Error ? err.message : String(err);
      if (error === 'cancelled') {
        return { success: false, output: '', error, status: 'cancelled' };
      }
      entry.failed++;
      return { success: false, output: '', error };
    }
  }

  private async waitForJobActive(
    job: Job<QueuedTask>,
    queueEvents: QueueEvents,
    maxWaitMs = this.getQueueWaitMaxMs(),
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const taskId = job.data.taskId;
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let cancelWait: (() => void) | null = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        queueEvents.off('active', onActive);
        queueEvents.off('removed', onRemoved);
        if (cancelWait && this.waitingBullMqAborters.get(taskId) === cancelWait) {
          this.waitingBullMqAborters.delete(taskId);
        }
        if (this.waitingBullMqJobs.get(taskId) === job) {
          this.waitingBullMqJobs.delete(taskId);
        }
      };

      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const onActive = ({ jobId }: { jobId: string }) => {
        if (jobId === job.id) {
          resolveOnce();
        }
      };

      const onRemoved = ({ jobId }: { jobId: string }) => {
        if (jobId === job.id) {
          rejectOnce(new Error('cancelled'));
        }
      };

      cancelWait = () => rejectOnce(new Error('cancelled'));
      this.waitingBullMqAborters.get(taskId)?.();
      this.waitingBullMqAborters.set(taskId, cancelWait);
      this.waitingBullMqJobs.set(taskId, job);

      queueEvents.on('active', onActive);
      // QueueEvents is Redis-stream backed, so a remove issued by another NCO
      // process settles this process's waiter immediately as well.
      queueEvents.on('removed', onRemoved);
      timer = setTimeout(() => {
        const message = `queue_wait_timeout: provider ${job.data.agentId} busy for ${maxWaitMs}ms`;
        void job.remove().catch(() => {});
        rejectOnce(new Error(message));
      }, maxWaitMs);

      void job.getState()
        .then(state => {
          if (state === 'active' || state === 'completed' || state === 'failed') {
            resolveOnce();
            return;
          }
          // waiting/delayed/prioritized/waiting-children → active 이벤트 대기 유지.
          // unknown = job이 이미 제거됨/조회불가 — 실행 예산을 태우지 말고 즉시 실패,
          // queue_wait_timeout 접두어로 failover 패턴에 걸리게 한다 (리뷰 MED).
          if (state === 'unknown') {
            rejectOnce(new Error(
              `queue_wait_timeout: job state unknown for provider ${job.data.agentId} (removed?)`,
            ));
          }
        })
        .catch(err => {
          rejectOnce(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  private async listBullMqJobsPaged(
    queue: Queue<QueuedTask>,
    states: JobType[],
  ): Promise<Job<QueuedTask>[]> {
    // BullMQ offsets are live-list offsets. If another process removes jobs
    // between pages, the list shifts left and a forward offset skips entries;
    // sustained inserts can also keep every page full forever. One 0..-1 Redis
    // range read gives this cleanup pass a finite snapshot instead.
    const snapshot = (await queue.getJobs(states, 0, -1, true))
      .filter((job): job is Job<QueuedTask> => job != null);
    const seen = new Set<string>();
    return snapshot.filter(job => {
      const id = String(job.id ?? `${job.data.taskId}:${job.timestamp}`);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  private async findWaitingBullMqJob(
    queue: Queue<QueuedTask>,
    taskId: string,
  ): Promise<Job<QueuedTask> | undefined> {
    const metadata = loadTaskMetadata(taskId);
    const knownIds = [
      resolveBullMqJobId(taskId, metadata.ncoQueueAttempt),
      taskId, // pre-generation legacy id
    ];
    for (const jobId of knownIds) {
      const job = await queue.getJob(jobId);
      if (!job || job.data.taskId !== taskId) continue;
      const state = await job.getState();
      if (state === 'waiting' || state === 'delayed') return job;
    }

    const states: JobType[] = ['wait', 'delayed', 'prioritized', 'paused'];
    const snapshot = await this.listBullMqJobsPaged(queue, states);
    return snapshot.find(candidate => candidate.data.taskId === taskId);
  }

  /**
   * Redis에 남은 terminal/missing job을 제거한다. Active job과 lock은 부팅 중에도
   * BullMQ stalled recovery만 소유하며 이 경로는 건드리지 않는다.
   */
  private async purgeStaleJobs(queue: Queue<QueuedTask>): Promise<number> {
    try {
      const db = getDb();
      const readStatus = db.prepare('SELECT status FROM tasks WHERE id=?');
      const preview = await inspectBullQueueStaleJobs(
        queue,
        taskId => (readStatus.get(taskId) as { status?: string } | undefined)?.status,
        {
          agentId: queue.name.replace(/^nco-agent-/, ''),
          mode: 'dry-run',
          startup: true,
          maxJobs: QUEUE_HYGIENE_MAX_JOBS_PER_QUEUE,
        },
      );
      const result = await inspectBullQueueStaleJobs(
        queue,
        taskId => (readStatus.get(taskId) as { status?: string } | undefined)?.status,
        {
          agentId: queue.name.replace(/^nco-agent-/, ''),
          mode: 'apply',
          startup: true,
          maxJobs: QUEUE_HYGIENE_MAX_JOBS_PER_QUEUE,
          plannedCandidateKeys: new Set(preview.candidateJobs.map(candidate => candidate.key)),
        },
      );
      if (result.removed > 0) {
        log.info({
          queue: queue.name,
          removed: result.removed,
          skippedActive: result.skippedActive,
          truncated: result.truncated,
        }, 'Purged stale BullMQ jobs');
      }
      return result.removed;
    } catch (error) {
      log.warn({
        queue: queue.name,
        error: error instanceof Error ? error.message : String(error),
      }, 'Failed to purge stale BullMQ jobs');
      return 0;
    }
  }

  /** Public, bounded, singleflight queue hygiene used by API/automatic control. */
  async runQueueHygiene(options: {
    mode?: 'dry-run' | 'apply';
    maxJobsPerQueue?: number;
    maxRetiredQueues?: number;
    maxDiscoveryKeys?: number;
    maxDiscoveryIterations?: number;
    plannedCandidateKeys?: readonly string[] | ReadonlySet<string>;
    canMutate?: () => boolean;
  } = {}): Promise<QueueHygieneResult> {
    if (this.queueHygieneInFlight) return this.queueHygieneInFlight;
    const run = async (): Promise<QueueHygieneResult> => {
      const mode = options.mode ?? 'dry-run';
      const plannedCandidateKeys = new Set(options.plannedCandidateKeys ?? []);
      const db = getDb();
      const readStatus = db.prepare('SELECT status FROM tasks WHERE id=?');
      const queues: QueueHygieneQueueResult[] = [];
      const namespace = resolveBullMqPrefix();
      const configuredQueueNames = new Set(
        this.currentProviderIds().map(agentId => `nco-agent-${agentId}`),
      );
      const inspectedQueueNames = new Set<string>();
      let discovery: RetiredBullMqQueueDiscovery | undefined;
      let retiredDiscoveryFailures = 0;

      const inspectQueue = async (
        queue: Queue<QueuedTask>,
        agentId: string,
        retired: boolean,
        ownerMarker: boolean,
      ): Promise<void> => {
        inspectedQueueNames.add(queue.name);
        try {
          queues.push(await inspectBullQueueStaleJobs(
            queue,
            taskId => (readStatus.get(taskId) as { status?: string } | undefined)?.status,
            {
              agentId,
              mode,
              startup: false,
              maxJobs: options.maxJobsPerQueue,
              plannedCandidateKeys,
              canMutate: options.canMutate,
              retired,
              ownerMarker,
            },
          ));
        } catch (error) {
          if (error instanceof Error && error.message === 'queue hygiene mutation lease lost') {
            throw error;
          }
          log.warn({
            agentId,
            queue: queue.name,
            retired,
            error: error instanceof Error ? error.message : String(error),
          }, 'Queue hygiene inspection failed');
          queues.push({
            agentId,
            queue: queue.name,
            examined: 0,
            candidates: 0,
            removed: 0,
            skippedActive: 0,
            skippedUnplanned: 0,
            errors: 1,
            truncated: false,
            retired,
            ownerMarker,
            skippedUnowned: 0,
            candidateJobs: [],
          });
        }
      };

      for (const [agentId, entry] of this.agents) {
        if (entry.mode !== 'bullmq' || !entry.queue) continue;
        const retired = !configuredQueueNames.has(entry.queue.name);
        await inspectQueue(entry.queue as Queue<QueuedTask>, agentId, retired, true);
      }

      // A clean boot only creates queues for the current provider catalog. Use
      // bounded SCAN to find historical NCO queue names in this exact prefix,
      // then reuse the same per-job compare-and-apply cleanup. No raw Redis key
      // or whole queue is deleted here.
      if (isRedisConnected()) {
        try {
          const redis = await getRedis();
          discovery = await discoverRetiredBullMqQueues({
            scan: async (cursor, ...args) => redis.scan(
              cursor,
              'MATCH',
              String(args[1]),
              'COUNT',
              Number(args[3]),
            ),
            get: key => redis.get(key),
          }, {
            namespace,
            configuredQueueNames,
            startCursor: this.retiredQueueDiscoveryCursor,
            maxQueues: options.maxRetiredQueues
              ?? Number(process.env.NCO_HYGIENE_RETIRED_QUEUE_MAX_QUEUES),
            maxKeys: options.maxDiscoveryKeys
              ?? Number(process.env.NCO_HYGIENE_RETIRED_QUEUE_MAX_KEYS),
            maxScanIterations: options.maxDiscoveryIterations
              ?? Number(process.env.NCO_HYGIENE_RETIRED_QUEUE_MAX_SCAN_ITERATIONS),
          });
          for (const candidate of discovery.retiredQueues) {
            if (inspectedQueueNames.has(candidate.queue)) continue;
            const retiredQueue = new Queue<QueuedTask>(candidate.queue, {
              connection: redis,
              prefix: namespace,
            });
            try {
              await inspectQueue(
                retiredQueue,
                candidate.agentId,
                true,
                candidate.ownerMarker,
              );
            } finally {
              await retiredQueue.close().catch(() => undefined);
            }
          }
          if (mode === 'apply') {
            this.retiredQueueDiscoveryCursor = discovery.nextCursor;
          }
        } catch (error) {
          if (error instanceof Error && error.message === 'queue hygiene mutation lease lost') {
            throw error;
          }
          log.warn({
            namespace,
            error: error instanceof Error ? error.message : String(error),
          }, 'Retired BullMQ queue discovery failed');
          retiredDiscoveryFailures += 1;
        }
      }
      return queues.reduce<QueueHygieneResult>((summary, queueResult) => ({
        mode,
        namespace: summary.namespace,
        isolatedNamespace: summary.isolatedNamespace,
        examined: summary.examined + queueResult.examined,
        candidates: summary.candidates + queueResult.candidates,
        removed: summary.removed + queueResult.removed,
        skippedActive: summary.skippedActive + queueResult.skippedActive,
        skippedUnplanned: summary.skippedUnplanned + queueResult.skippedUnplanned,
        errors: summary.errors + queueResult.errors,
        truncated: summary.truncated || queueResult.truncated,
        retiredQueues: (summary.retiredQueues ?? 0) + (queueResult.retired ? 1 : 0),
        skippedUnowned: (summary.skippedUnowned ?? 0) + (queueResult.skippedUnowned ?? 0),
        discovery,
        queues: [...summary.queues, queueResult],
      }), {
        mode,
        namespace,
        isolatedNamespace: namespace !== 'bull',
        examined: 0,
        candidates: 0,
        removed: 0,
        skippedActive: 0,
        skippedUnplanned: 0,
        errors: (discovery?.errors ?? 0) + retiredDiscoveryFailures,
        truncated: discovery?.truncated ?? false,
        retiredQueues: 0,
        skippedUnowned: 0,
        discovery,
        queues: [],
      });
    };
    this.queueHygieneInFlight = run().finally(() => {
      this.queueHygieneInFlight = null;
    });
    return this.queueHygieneInFlight;
  }

  private async enqueueSemaphore(task: QueuedTask, entry: AgentQueueEntry): Promise<TaskExecutionResult> {
    if (!this.executor) return { success: false, output: '', error: 'Executor not set' };

    entry.waiting++;
    this.refreshEntryConcurrency(task.agentId, entry);
    const acquired = await this.withQueueWaitLeaseRenewal(task, () => entry.semaphore.acquire(task.taskId));
    entry.waiting = Math.max(0, entry.waiting - 1);
    if (!acquired) {
      return { success: false, output: '', error: 'cancelled', status: 'cancelled' };
    }
    if (!this.entryAccepts(task.agentId, entry)) {
      entry.semaphore.release();
      return this.providerUnavailable(task.agentId);
    }

    const controller = new AbortController();
    try {
      this.startRuntime(task, controller);
    } catch (err) {
      // Same slot-leak hazard as the BullMQ path (P1-1) — release before propagating.
      entry.semaphore.release();
      throw err;
    }
    entry.activeControllers.set(task.taskId, controller);
    entry.active++;

    const invocationId = task.metadata?.invocationId as string | undefined;
    try {
      // Match the BullMQ path: invocation tracking begins only after local
      // resources are registered, so it belongs inside the same try/finally.
      if (invocationId) {
        invocationTracker.startInvocation(invocationId);
      }
      const verifierBaseline = await this.getOrCaptureVerifierBaseline(task, controller.signal);
      const result = await this.executor(task, controller.signal);
      const finalized = this.finalizeRuntime(task.taskId, result);
      const classified = classifyResult(finalized);
      const gated = await applyVerifierGate(task, classified, controller.signal, verifierBaseline);
      const terminal = this.applyRuntimeMetadata(task.taskId, gated, finalized);
      // P2-10 pa-lifecycle: 에이전트 사용 기록(웜 유지/축출 결정 근거). sticky는 cold-start 절감.
      paLifecycle.markUsed(task.agentId, Date.now());
      if (terminal.success) entry.completed++;
      else entry.failed++;
      if (invocationId) {
        const summary = (terminal.output || '').slice(0, 2000);
        invocationTracker.completeInvocation(
          invocationId,
          terminal.success ? 'completed' : 'failed',
          terminal.success ? summary : undefined,
          terminal.success ? undefined : (terminal.error || terminal.output),
          terminal.usage,
        );
        await invocationTracker.notifyCompletion(invocationId);
      }
      return terminal;
    } catch (err: any) {
      const finalized = this.finalizeRuntime(task.taskId, {
        success: false,
        output: '',
        error: err?.message || 'unknown: execution failed',
        status: 'failed',
      });
      entry.failed++;
      if (invocationId) {
        invocationTracker.completeInvocation(invocationId, 'failed', undefined, finalized.error || err?.message);
        await invocationTracker.notifyCompletion(invocationId);
      }
      return finalized;
    } finally {
      try {
        await this.finishTaskExecution(task);
      } finally {
        entry.activeControllers.delete(task.taskId);
        entry.active = Math.max(0, entry.active - 1);
        entry.semaphore.release();
      }
    }
  }

  /**
   * Abort a running or queued task. Works for both BullMQ and semaphore modes.
   * - If queued (not yet active): cancel the semaphore waiter or remove from BullMQ
   * - If active: send AbortSignal to the running process
   */
  async abortAndWaitForExecutionExit(
    taskId: string,
    timeoutMs = EXECUTION_EXIT_WAIT_MS,
  ): Promise<boolean> {
    const runtimeAtSignal = this.runtimes.get(taskId);
    const expectedPid = runtimeAtSignal?.childPid ?? null;
    const signalled = await this.abort(taskId);
    if (!signalled) return false;
    return waitForExecutionExit(() => {
      const runtime = this.runtimes.get(taskId);
      return runtime != null || isPidAlive(expectedPid);
    }, timeoutMs);
  }

  async abort(taskId: string): Promise<boolean> {
    for (const [agentId, entry] of this.agents) {
      const controller = entry.activeControllers.get(taskId);
      if (controller) {
        this.setAbortReason(taskId, 'cancelled');
        controller.abort(new Error('cancelled'));
        entry.activeControllers.delete(taskId);
        log.info({ agentId, taskId }, 'Task aborted (active)');
        return true;
      }

      // Semaphore fallback jobs, and BullMQ jobs admitted by a worker but still
      // waiting behind the dynamic local-concurrency gate, have no controller yet.
      if (entry.semaphore.cancel(taskId)) {
        log.info({ agentId, taskId }, 'Task aborted (waiting for semaphore)');
        return true;
      }

      // Try to remove from BullMQ queue (still waiting)
      if (entry.queue) {
        try {
          let job = this.waitingBullMqJobs.get(taskId)
            ?? await this.findWaitingBullMqJob(entry.queue, taskId);
          if (job) {
            await job.remove();
            const cancelWait = this.waitingBullMqAborters.get(taskId);
            if (cancelWait) {
              // enqueueBullMQ owns the single waiting-count decrement in its catch.
              cancelWait();
            } else {
              // Compatibility fallback for a job restored before this process had
              // registered its active-event listener.
              entry.waiting = Math.max(0, entry.waiting - 1);
            }
            log.info({ agentId, taskId }, 'Task removed from queue (waiting)');
            return true;
          }
        } catch { /* job may have already started */ }
      }

      // The job may have crossed from waiting to active while remove() awaited.
      // Re-check both pre-execution and active cancellation handles once.
      if (entry.semaphore.cancel(taskId)) {
        log.info({ agentId, taskId }, 'Task aborted after queue activation (waiting for semaphore)');
        return true;
      }
      const activatedController = entry.activeControllers.get(taskId);
      if (activatedController) {
        this.setAbortReason(taskId, 'cancelled');
        activatedController.abort(new Error('cancelled'));
        entry.activeControllers.delete(taskId);
        log.info({ agentId, taskId }, 'Task aborted after queue activation');
        return true;
      }
    }
    return false;
  }

  /** Interrupt the exact active tasks left after the bounded shutdown drain. */
  interruptActiveTasks(taskIds: readonly string[]): number {
    const targets = new Set(taskIds);
    let interrupted = 0;
    for (const [agentId, entry] of this.agents) {
      for (const [taskId, controller] of entry.activeControllers) {
        if (!targets.has(taskId) || controller.signal.aborted) continue;
        this.setAbortReason(taskId, 'cancelled');
        controller.abort(new Error(GRACEFUL_SHUTDOWN_INTERRUPTION));
        interrupted += 1;
        log.warn({ agentId, taskId }, 'Interrupted active task after shutdown drain timeout');
      }
    }
    return interrupted;
  }

  /**
   * Get queue metrics for all agents (or a specific one).
   */
  async getMetrics(agentId?: string): Promise<QueueMetrics[]> {
    const results: QueueMetrics[] = [];
    const entries = agentId
      ? [[agentId, this.agents.get(agentId)]] as [string, AgentQueueEntry | undefined][]
      : [...this.agents.entries()];

    for (const [id, entry] of entries) {
      if (!entry) continue;

      let waiting = entry.waiting;
      let active = entry.active;

      // BullMQ mode: get real counts from queue
      if (entry.mode === 'bullmq' && entry.queue) {
        try {
          const live = await readBullQueueLiveCounts(entry.queue);
          waiting = live.waiting;
          active = live.active;
        } catch { /* use cached counts */ }
      }

      results.push({
        agentId: id,
        waiting,
        active,
        completed: entry.completed,
        failed: entry.failed,
        concurrency: entry.concurrency,
        mode: entry.mode,
      });
    }

    return results;
  }

  /**
   * Admission control must never treat cached BullMQ counters as a live queue
   * snapshot. Health/observability callers keep using getMetrics(), which is
   * intentionally resilient; intake backpressure uses this fail-closed view.
   */
  async getAdmissionMetrics(agentId?: string): Promise<QueueMetrics[]> {
    const results: QueueMetrics[] = [];
    const entries = agentId
      ? [[agentId, this.agents.get(agentId)]] as [string, AgentQueueEntry | undefined][]
      : [...this.agents.entries()];

    for (const [id, entry] of entries) {
      if (!entry) continue;

      let waiting = entry.waiting;
      let active = entry.active;
      if (entry.mode === 'bullmq') {
        if (!entry.queue) {
          throw new Error(`admission queue unavailable: ${id}`);
        }
        const live = await readBullQueueLiveCounts(entry.queue);
        waiting = live.waiting;
        active = live.active;
      }

      results.push({
        agentId: id,
        waiting,
        active,
        completed: entry.completed,
        failed: entry.failed,
        concurrency: entry.concurrency,
        mode: entry.mode,
      });
    }

    return results;
  }

  async close(options: {
    forceWorkers?: boolean;
    executionExitWaitMs?: number;
  } = {}): Promise<void> {
    // Closing without an earlier process-level signal still enters a durable
    // draining state. Ownership heartbeats and lease renewal intentionally stay
    // active until every worker and provider execution has actually exited.
    if (this.ownershipState !== 'draining') {
      this.beginShutdown(this.shutdownSignal ?? 'close');
    }
    if (this.priorityAgingTimer) {
      clearInterval(this.priorityAgingTimer);
      this.priorityAgingTimer = null;
    }
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    if (this.priorityAgingInFlight) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const deadline = new Promise<void>(resolve => {
        timer = setTimeout(resolve, PRIORITY_AGING_CLOSE_WAIT_MS);
        timer.unref?.();
      });
      await Promise.race([
        this.priorityAgingInFlight.then(() => undefined, () => undefined),
        deadline,
      ]);
      if (timer) clearTimeout(timer);
    }
    for (const cancelWait of [...this.waitingBullMqAborters.values()]) cancelWait();
    this.waitingBullMqAborters.clear();
    for (const entry of this.agents.values()) {
      entry.semaphore?.cancelAll();
      // Graceful drain is completed by src/index.ts before this method. BullMQ
      // worker.close(false) has no timeout and waits for active jobs forever;
      // force=true skips only that wait and still closes worker resources.
      if (entry.worker) await entry.worker.close(options.forceWorkers === true);
    }
    const executionsExited = await waitForExecutionExit(() => (
      this.runtimes.size > 0
      || [...this.externalExecutions.values()].some(execution => isPidAlive(execution.pid))
    ), options.executionExitWaitMs ?? EXECUTION_EXIT_WAIT_MS);
    if (!executionsExited) {
      // Fail closed: a sibling must continue to see this draining instance as
      // live rather than reclaiming provider work that may still be running.
      // Queue transports also stay open: forced worker.close() returns before
      // its processor callback settles, and closing the shared Queue first can
      // make that callback lose its final durable completion write.
      const activeTaskIds = [...this.runtimes.keys()];
      const liveExternalExecutionIds = [...this.externalExecutions.entries()]
        .filter(([, execution]) => isPidAlive(execution.pid))
        .map(([executionId]) => executionId);
      throw new TaskQueueCloseTimeoutError(
        activeTaskIds,
        liveExternalExecutionIds,
        options.executionExitWaitMs ?? EXECUTION_EXIT_WAIT_MS,
      );
    }
    // Active BullMQ processor callbacks are now settled, so their completion
    // acknowledgements cannot race a transport close.
    for (const entry of this.agents.values()) {
      if (entry.queue) await entry.queue.close();
      if (entry.queueEvents) await entry.queueEvents.close();
    }
    this.agents.clear();
    this.providerConfigs.clear();
    this.providerViewCommitted = false;
    this.externalExecutions.clear();
    if (this.ownershipHeartbeatTimer) {
      clearInterval(this.ownershipHeartbeatTimer);
      this.ownershipHeartbeatTimer = null;
    }
    try {
      stopTaskQueueInstance(getDb());
    } catch {
      // Database shutdown may already be in progress in embedded callers.
    }
    this.initialized = false;
    this.reconcileSerial = Promise.resolve();
  }

  recordActivity(taskId: string, chunk?: string): void {
    const runtime = this.runtimes.get(taskId);
    if (!runtime) {
      if (this.externalExecutions.has(taskId)) touchRuntimeSessionProcess(taskId);
      return;
    }
    const now = Date.now();
    runtime.lastActivityAt = now;
    runtime.firstActivityObserved = true;
    if (chunk && chunk.length > 0) {
      runtime.lastOutputAt = now;
      runtime.firstOutputAt ??= now;
      runtime.firstOutputObserved = true;
      runtime.partialOutput = (runtime.partialOutput + chunk).slice(-PARTIAL_OUTPUT_LIMIT);
    }
    runtime.liveness = 'working';
    runtime.stalledSince = null;
    this.flushActivityToDb(runtime);
  }

  recordChildProcess(taskId: string, pid: number | null | undefined): void {
    const runtime = this.runtimes.get(taskId);
    if (!pid || pid <= 0) return;
    if (!runtime) {
      const execution = this.externalExecutions.get(taskId);
      if (execution) {
        execution.pid = pid;
        registerRuntimeSessionProcess({ sessionId: taskId, agentId: execution.agentId, pid });
      }
      return;
    }
    runtime.childPid = pid;
    runtime.processAlive = true;
    registerRuntimeProcess({ taskId, agentId: runtime.agentId, pid });
    this.recordActivity(taskId);
  }

  getTaskSnapshot(
    taskId: string,
    persisted?: { lastActivityAt?: string | null },
  ): { lastActivityAt: string | null; liveness: LivenessState } {
    const runtime = this.runtimes.get(taskId);
    if (!runtime) {
      // 목록 API는 이미 tasks.last_activity_at을 읽었다. 그 값을 넘기면 태스크마다
      // 같은 행을 다시 SELECT 하는 N+1을 피하면서 단건 API의 기존 DB fallback은 유지한다.
      if (persisted) {
        return { lastActivityAt: persisted.lastActivityAt ?? null, liveness: 'dead' };
      }
      const row = getDb().prepare('SELECT last_activity_at FROM tasks WHERE id=?').get(taskId) as { last_activity_at?: string | null } | undefined;
      return { lastActivityAt: row?.last_activity_at ?? null, liveness: 'dead' };
    }
    return {
      lastActivityAt: new Date(runtime.lastActivityAt).toISOString(),
      liveness: runtime.liveness,
    };
  }

  /**
   * 이 태스크의 실행이 아직 살아 있는가. 리스 스위퍼가 "시각은 지났지만 프로세스는
   * 일하는 중"인 태스크를 죽이지 않도록 판정에 쓴다.
   *
   * 살아 있다고 보는 조건은 셋 중 하나다.
   *   - 자식 프로세스가 실제로 살아 있다(childPid 가 있고 kill(pid,0) 성공)
   *   - 자식 프로세스를 안 쓰는 실행이다(Type C API — childPid 가 없음)
   *   - 아직 abort 되지 않았고 hard-cap 안에 있다
   * abortReason 이 이미 잡힌 실행은 종료 절차에 들어간 것이므로 유예하지 않는다.
   */
  isExecutionAlive(taskId: string): boolean {
    const runtime = this.runtimes.get(taskId);
    if (!runtime) return false;              // 런타임이 없으면 이 인스턴스가 실행 중이 아니다
    if (runtime.abortReason) return false;   // 이미 종료 판정을 받았다
    if (Date.now() - runtime.startedAt >= runtime.timeoutMs) return false;  // hard-cap 초과
    if (!runtime.childPid) return true;      // API 경로 — 프로세스 개념이 없다
    return this.sampleProcess(runtime.childPid).alive;
  }

  getAbortReason(taskId: string): TaskRuntimeEntry['abortReason'] | undefined {
    return this.runtimes.get(taskId)?.abortReason;
  }

  getShutdownSignal(taskId: string): string | undefined {
    return this.runtimes.get(taskId)?.shutdownSignal ?? undefined;
  }

  getBufferedOutput(taskId: string): string {
    return this.runtimes.get(taskId)?.partialOutput ?? '';
  }

  private getHardTimeoutMs(taskTimeoutMs?: number): number {
    return taskTimeoutMs && Number.isFinite(taskTimeoutMs) && taskTimeoutMs > 0 ? taskTimeoutMs : 1_200_000;
  }

  private getIdleTimeoutMs(): number {
    const raw = Number(process.env.NCO_TASK_IDLE_TIMEOUT_MS);
    return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_IDLE_TIMEOUT_MS;
  }

  private getFirstActivityTimeoutMs(): number {
    const raw = Number(process.env.NCO_FIRST_ACTIVITY_TIMEOUT_MS);
    return Number.isFinite(raw) && raw >= 60_000 ? raw : 180_000;
  }

  private getQueueWaitMaxMs(): number {
    const raw = Number(process.env.NCO_QUEUE_WAIT_MAX_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_QUEUE_WAIT_MAX_MS;
  }

  private getBullWaitTimeoutMs(taskTimeoutMs?: number): number {
    return this.getHardTimeoutMs(taskTimeoutMs) + 30_000;
  }

  /**
   * 세마포어 대기 중 리스를 갱신한다.
   *
   * 리스는 **ack 시점**에 90초로 시작한다(`lease-sweeper.ts` ack 경로). 그런데 갱신자는
   * `flushActivityToDb` 하나뿐이고, 그것은 `this.runtimes` 에 등록된 런타임이 있어야
   * 돈다. 런타임은 `startRuntime` 에서 만들어지는데 그 앞에 **상한 없는 세마포어 대기**가
   * 있다. 그래서 큐에서 기다리는 동안에는 아무도 리스를 갱신하지 않는다.
   *
   * 결과적으로 `concurrency=1` 인 프로바이더 뒤에 줄을 선 태스크는 **시작도 못 해 보고**
   * 90초 뒤 sweeper 에게 `lease_expired` 로 죽는다. 큐 대기 상한은 30분
   * (`DEFAULT_QUEUE_WAIT_MAX_MS`)인데 리스가 90초라 상한이 무력화돼 있었다.
   *
   * kangnote 실측(2026-08-06)이 이 형태와 맞는다 — lease_expired 104건 중 67건이
   * `heartbeat_seq <= 2` 이고 그중 61건은 하트비트 지속 시간이 **0초**다. 한 번 찍히고
   * 그 뒤 갱신이 전혀 없다. 수명 중앙값 97초로 리스 90초 직후에 몰린다. 그 무리에
   * ollama·claude-code 가 많은 것도 맞는다 — 느리거나 concurrency=1 이라 줄이 길다.
   *
   * 대기 중에도 owner 는 살아 있으므로 갱신이 옳다. 무한 갱신을 막는 것은 큐 대기 상한이
   * 이미 담당한다 — 그 상한을 넘기면 갱신을 멈춰 sweeper 가 거두게 둔다.
   */
  private async withQueueWaitLeaseRenewal<T>(task: QueuedTask, wait: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.getQueueWaitMaxMs();
    const timer = setInterval(() => {
      if (Date.now() >= deadline) return;
      try {
        recordTaskHeartbeat(task.taskId);
      } catch (err) {
        log.debug({ taskId: task.taskId, err }, 'Queue-wait lease renewal skipped');
      }
    }, QUEUE_WAIT_HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    try {
      return await wait();
    } finally {
      clearInterval(timer);
    }
  }

  private startRuntime(task: QueuedTask, controller: AbortController): void {
    const now = Date.now();
    const queueAttempt = normalizeQueueAttempt(task.metadata?.ncoQueueAttempt);
    const runtime: TaskRuntimeEntry = {
      taskId: task.taskId,
      agentId: task.agentId,
      queueAttempt,
      controller,
      startedAt: now,
      timeoutMs: this.getHardTimeoutMs(task.timeoutMs),
      idleTimeoutMs: this.getIdleTimeoutMs(),
      firstActivityTimeoutMs: this.getFirstActivityTimeoutMs(),
      lastActivityAt: now,
      lastOutputAt: now,
      firstOutputAt: null,
      firstActivityObserved: false,
      firstOutputObserved: false,
      lastDbFlushAt: 0,
      partialOutput: '',
      childPid: null,
      lastCpuSeconds: null,
      processAlive: true,
      liveness: 'working',
      stalledSince: null,
      lastHeartbeatFlushAt: 0,
    };
    const started = markTaskExecutionStarted(task.taskId, queueAttempt, task.agentId);
    if (!started.ok) {
      // P1-1: task-state.transitionTask already rejects queued/assigned→running dupes at
      // the DB layer, but a stale BullMQ job (redispatched/retried against an already
      // terminal or missing task) previously fell through to this warn-and-continue path and
      // executed anyway, producing buried duplicate results or FK registration failures.
      // Abort before provider budget is spent and use UnrecoverableError so BullMQ will not
      // retry a queue item that has no valid durable state transition.
      const duplicateError = terminalDuplicateExecutionError(task.taskId, started.prev);
      if (duplicateError) {
        recordLearningEvent({
          agentId: task.agentId,
          eventType: 'duplicate_execution',
          pattern: started.prev ?? 'missing_durable_task',
          context: {
            taskId: task.taskId,
            error: duplicateError.message,
          },
        });
        log.warn(
          { taskId: task.taskId, prev: started.prev },
          'Invalid queued execution blocked before provider dispatch',
        );
        throw duplicateError;
      }
      const attemptError = queueAttemptDuplicateExecutionError(
        task.taskId,
        queueAttempt,
        started.reason ?? 'invalid_transition',
      );
      recordLearningEvent({
        agentId: task.agentId,
        eventType: 'duplicate_execution',
        pattern: started.reason ?? 'invalid_transition',
        context: {
          taskId: task.taskId,
          queueAttempt,
          error: attemptError.message,
        },
      });
      log.warn(
        { taskId: task.taskId, prev: started.prev, queueAttempt, reason: started.reason },
        'Duplicate or stale queue attempt blocked before provider dispatch',
      );
      throw attemptError;
    }
    this.runtimes.set(task.taskId, runtime);
    this.flushActivityToDb(runtime);
  }

  private finalizeRuntime(taskId: string, result: TaskExecutionResult): TaskExecutionResult {
    const runtime = this.runtimes.get(taskId);
    if (!runtime) return result;
    this.flushActivityToDb(runtime);
    if (runtime.childPid != null) {
      unregisterRuntimeProcess(taskId, getDb(), runtime.childPid);
    }
    this.runtimes.delete(taskId);
    const output = result.output || runtime.partialOutput;
    const status = result.status ?? (
      runtime.abortReason === 'cancelled'
        ? 'cancelled'
        : runtime.abortReason?.startsWith('timeout(')
          ? 'timed_out'
          : result.success
            ? 'completed'
            : 'failed'
    );
    // Aborted tasks can never be successes: Type B loops swallow a canceled CLI
    // call into a "[<agent>: CLI failed ...]" output string and finish with
    // success=true, which used to early-return in enqueue() before the
    // stall-retry check ever ran (2026-07-03 task_fjmW7ww5 실측).
    const aborted = runtime.abortReason != null;
    const success = aborted ? false : result.success;
    const error = aborted
      ? (runtime.abortReason || result.error)
      : (result.error || (!result.success ? 'unknown: execution failed' : undefined));
    const finalized = normalizeGracefulShutdownInterruption(
      { ...result, success, output, error, status },
      this.shutdownSignal,
      runtime.shutdownSignal != null,
    );

    // 프로바이더급 실패(쿼터·레이트리밋·인증)를 서킷에 반영한다.
    //
    // 이 호출이 없어서 **태스크 실행 실패가 서킷에 전혀 안 잡혔다.** recordFailure 는
    // 코드 전체에서 헬스 프로브 한 곳에서만 불렸고, 실행 경로는 getAvailability 로 읽기만
    // 했다. 그래서 프로바이더가 모든 태스크를 429 로 떨어뜨려도 서킷은 닫힌 채였다
    // (gentop 실측 2026-08-07: hermes 349건 배정 · 완료 0건 · consecutiveFailures 0).
    // 헬스체크가 대부분 `--version` 이라 쿼터가 말라도 rc=0 이라 프로브만으로는 안 열린다.
    //
    // 태스크 고유 실패로 프로바이더를 죽이지 않도록 **프로바이더급으로 분류된 것만** 넘긴다.
    if (!finalized.success) {
      const signal = classifyTaskFailureForCircuit({
        error: finalized.error,
        output: finalized.output,
      });
      if (signal) {
        try {
          circuitBreakerRegistry.recordFailure(runtime.agentId, finalized.error ?? signal.matchedText);
          log.warn({
            taskId, agentId: runtime.agentId,
            reason: signal.reason, matched: signal.matchedText,
          }, '프로바이더급 실패를 서킷에 반영했다');
        } catch (err) {
          log.warn({ taskId, agentId: runtime.agentId, err }, '서킷 반영 실패');
        }
      }
    }

    return finalized;
  }

  /** Release the durable attempt fence only after all queue-side processing. */
  private async finishTaskExecution(task: QueuedTask): Promise<void> {
    const queueAttempt = normalizeQueueAttempt(task.metadata?.ncoQueueAttempt);
    try {
      if (!await finishTaskExecutionWithRetry(task.taskId, queueAttempt, task.agentId)) {
        log.debug(
          { taskId: task.taskId, queueAttempt, agentId: task.agentId },
          'Execution generation finish marker was already superseded',
        );
      }
    } catch (error) {
      log.error({
        taskId: task.taskId,
        queueAttempt,
        agentId: task.agentId,
        error: error instanceof Error ? error.message : String(error),
      }, 'Durable execution finish retries exhausted; deferring to lease recovery');
      throw error;
    }
  }

  private applyRuntimeMetadata(taskId: string, result: TaskExecutionResult, finalized: TaskExecutionResult): TaskExecutionResult {
    const terminal = {
      ...result,
      output: result.output || finalized.output,
      error: result.error || finalized.error,
      status: result.status || finalized.status,
    };
    const evidence = extractTaskEvidenceJson(terminal.output || '');
    if (evidence.warning) {
      log.warn({ taskId, warning: evidence.warning }, 'Ignoring invalid task evidence');
    }
    // Evidence assembled from the durable AgentToolExecutor ledger is T1 and
    // must not be replaced by a later evidence block from model-authored prose.
    if (terminal.evidenceJson) return terminal;
    return evidence.evidenceJson
      ? { ...terminal, evidenceJson: evidence.evidenceJson }
      : terminal;
  }

  private flushActivityToDb(runtime: TaskRuntimeEntry): void {
    const now = Date.now();
    if (now - runtime.lastDbFlushAt < 1_000) return;
    // lease는 provider의 출력 유무가 아니라 이 runtime owner가 살아 있는지를 증명한다.
    // 첫 활동 제한(기본 180초)보다 lease(90초)가 짧으므로 출력/CPU 증가 후에만 갱신하면
    // 정상 cold start를 sweeper가 먼저 만료시킨다. monitor tick 또는 stream callback이
    // 살아 있는 동안 갱신하고, 실제 무활동 판정은 first-activity/idle/hard-cap이 담당한다.
    const shouldFlushHeartbeat = now - runtime.lastHeartbeatFlushAt >= 1_000;
    const persisted = runBestEffortSqliteWrite(() => {
      getDb().prepare(`
        UPDATE tasks
        SET last_activity_at=?, updated_at=datetime('now')
        WHERE id=?
      `).run(new Date(runtime.lastActivityAt).toISOString(), runtime.taskId);
      if (shouldFlushHeartbeat) {
        recordTaskHeartbeat(runtime.taskId);
        renewTaskQueueOwnership(getDb(), runtime.taskId, runtime.queueAttempt, now);
      }
    });
    // busy_timeout 대기 중 들어온 다음 stream chunk가 곧바로 DB를 다시 때리지 않게
    // 시도 시작이 아니라 종료 시각부터 throttle한다.
    runtime.lastDbFlushAt = Date.now();
    if (persisted.ok) {
      if (shouldFlushHeartbeat) runtime.lastHeartbeatFlushAt = runtime.lastDbFlushAt;
      return;
    }
    const context = {
      taskId: runtime.taskId,
      agentId: runtime.agentId,
      err: persisted.error,
    };
    if (persisted.retryable) {
      log.warn(context, 'Deferred task activity persistence because SQLite is busy');
    } else {
      log.error(context, 'Task activity persistence failed');
    }
  }

  private monitorRuntime(runtime: TaskRuntimeEntry): void {
    if (runtime.abortReason) {
      // 여기서 그냥 return 하면 abort 시점부터 리스 갱신이 끊긴다. 프로바이더를 죽이고
      // finalizeRuntime 이 종료 상태를 쓰기까지 90초를 넘기면 sweeper 가 먼저 도달해
      // **진짜 사유가 lease_expired 로 덮인다.** 그러면 로그에 사인만 남고 원인이 사라진다
      // (프로세스 사망 분기에서 이미 같은 실수를 했고 되돌린 적이 있다).
      //
      // 되감기 중에는 owner 가 살아 있으므로 갱신이 옳다. 다만 무한히 갱신하면 정리가
      // 멈춘 태스크를 영영 못 거둔다. 그래서 유예 시간까지만 갱신하고 그 뒤에는 놓아준다.
      const abortedAt = runtime.abortedAt ?? 0;
      if (abortedAt && Date.now() - abortedAt < ABORT_UNWIND_GRACE_MS) {
        this.flushActivityToDb(runtime);
      }
      return;
    }
    const now = Date.now();
    if (now - runtime.startedAt >= runtime.timeoutMs) {
      this.setAbortReason(runtime.taskId, 'timeout(hardcap)');
      runtime.controller.abort(new Error('timeout(hardcap)'));
      return;
    }

    if (!runtime.firstActivityObserved && now - runtime.startedAt >= runtime.firstActivityTimeoutMs) {
      this.setAbortReason(runtime.taskId, 'timeout(first-activity)');
      runtime.controller.abort(new Error('timeout(first-activity)'));
      return;
    }

    const { alive, cpuSeconds } = this.sampleProcess(runtime.childPid);
    runtime.processAlive = alive;
    if (cpuSeconds !== null) {
      if (runtime.lastCpuSeconds !== null && cpuSeconds > runtime.lastCpuSeconds) {
        runtime.lastActivityAt = now;
        runtime.firstActivityObserved = true;
        runtime.liveness = 'working';
        runtime.stalledSince = null;
      }
      runtime.lastCpuSeconds = cpuSeconds;
    }

    if (runtime.childPid && !alive) {
      runtime.liveness = 'dead';
      // **abort 하면 안 된다.** 프로세스 사망과 태스크 실패는 같지 않다.
      // finalizeRuntime 이 runtimes.delete 를 할 때까지 childPid 가 남으므로,
      // 프로바이더가 **정상 종료한 뒤 후처리(verifier·품질 게이트) 중인** 태스크도
      // 여기서 !alive 로 보인다. 그때 abort 를 걸면 완료 직전 태스크를 죽인다.
      // (초판에서 실제로 이 회귀를 넣었다가 호출 순서를 확인하고 되돌렸다.)
      //
      // 진짜 문제는 여기서 그냥 return 하는 것이었다. 그러면 flushActivityToDb 를
      // 못 타 **활동 기록과 리스 갱신이 동시에 멈춘다**. 90초(LEASE_DURATION_MS) 뒤
      // sweeper 가 `lease_expired` 로 죽인다.
      //
      // 실측이 이 경로를 정확히 가리킨다(2026-08-06 라이브, 최근 2일):
      //  - lease_expired 3,365건, error 원문은 `lease_expired`/`lease_expired_twice`
      //    둘뿐이라 사인만 남고 원인이 없다. hb>1 이 2,171건.
      //  - `updated_at - last_activity_at` 평균이 claude-code 101초·opencode 109초이고,
      //    `lease_expires_at - last_heartbeat_at` 은 **전 프로바이더 정확히 90.0초**다.
      //    활동 정지 시점과 heartbeat 정지 시점이 겹친다 — 둘 다 이 return 때문이다.
      //
      // 태스크를 죽이면 안 되는 이유는 **정상 완료가 원래 오래 걸리기 때문**이다.
      // 같은 기간 completed 평균 수명: claude-code 3,317초(55분), ollama 10,271초(2.9h),
      // openclaw 523초. 리스 90초는 이 작업들에 비해 훨씬 짧고, 프로세스가 살아 있는
      // 동안에는 tick 이 갱신해 주기 때문에 유지된다. 그 갱신이 끊기는 순간만 죽는다.
      //
      // (초판 주석에서 "verifier 가 빌드를 돌려 90초를 넘는다"를 원인으로 적었으나
      //  반증됐다 — lease_expired 중 verifier 있는 것이 238건, 없는 것이 3,134건이고
      //  평균 수명도 207초 대 217초로 차이가 없다. verifier 는 범인이 아니다.)
      //
      // 그래서 abort 대신 **리스 갱신을 계속한다.** 실제 종료는 실행 경로가 결과를
      // 반환할 때 이뤄지고, 진짜 무응답은 idle/hard-cap 타임아웃이 잡는다.
      this.flushActivityToDb(runtime);
      return;
    }

    const idleMs = now - runtime.lastActivityAt;
    if (runtime.firstActivityObserved && idleMs >= runtime.idleTimeoutMs) {
      runtime.stalledSince ??= now;
      runtime.liveness = alive || !runtime.childPid ? 'stalled' : 'dead';
      if (runtime.liveness === 'stalled') {
        this.setAbortReason(runtime.taskId, 'timeout(idle)');
        runtime.controller.abort(new Error('timeout(idle)'));
      }
    } else {
      runtime.liveness = 'working';
      runtime.stalledSince = null;
    }

    this.flushActivityToDb(runtime);
  }

  private sampleProcess(pid: number | null): { alive: boolean; cpuSeconds: number | null } {
    if (!pid) return { alive: true, cpuSeconds: null };
    try {
      process.kill(pid, 0);
    } catch {
      return { alive: false, cpuSeconds: null };
    }
    try {
      const raw = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      return { alive: true, cpuSeconds: this.parsePsTime(raw) };
    } catch {
      return { alive: true, cpuSeconds: null };
    }
  }

  private parsePsTime(raw: string): number | null {
    if (!raw) return null;
    const parts = raw.trim().split(':').map(part => Number(part));
    if (parts.some(part => Number.isNaN(part))) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  private setAbortReason(taskId: string, reason: NonNullable<TaskRuntimeEntry['abortReason']>): void {
    const runtime = this.runtimes.get(taskId);
    if (!runtime || runtime.abortReason) return;
    runtime.abortReason = reason;
    runtime.abortedAt = Date.now();
  }
}

export const taskQueue = new TaskQueueManager();

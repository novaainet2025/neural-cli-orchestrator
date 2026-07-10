/**
 * TaskQueueManager — BullMQ-backed per-agent task queue
 *
 * Each agent gets its own Queue + Worker with concurrency capped at
 * provider.concurrency (from ai-providers.json).
 *
 * Fallback: if Redis is unavailable, a simple in-memory semaphore
 * limits concurrency so CLI processes don't conflict.
 */

import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { spawn, execFileSync, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { isRedisConnected, getRedis } from '../storage/redis.js';
import { loadEnabledProviders, env, type ProviderConfig } from '../utils/config.js';
import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';
import { invocationTracker } from './invocation-tracker.js';
import { CommandGate } from '../security/command-gate.js';
import { extractTaskEvidenceJson } from './task-evidence.js';
import { requireEvidence } from '../security/evidence-gate.js';
import { paLifecycle } from './ported-integrations.js';
import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';
import { acknowledgeTaskLease, recordTaskHeartbeat } from './lease-sweeper.js';
import { appendAttemptedAgent, decideFinalEscalation, getAttemptedAgents } from './task-escalation.js';

// ─── Rate Limit Detection ─────────────────────────────
const RATE_LIMIT_PATTERNS = [
  /rate.limit/i,
  /too many requests/i,
  /429/,
  /quota.exceeded/i,
  /resource.exhausted/i,
  /slowdown/i,
];

function isRateLimitError(message: string): boolean {
  return RATE_LIMIT_PATTERNS.some(p => p.test(message));
}

// ─── Retry Config ─────────────────────────────────────
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 5_000; // 5s, then 10s, then 20s
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const TASK_MONITOR_INTERVAL_MS = 15_000;
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
const DYNAMIC_LOCAL_CONCURRENCY_IDS = new Set(['mlx', 'ollama', 'hermes']);

// ─── Types ────────────────────────────────────────────
export interface QueuedTask {
  taskId: string;
  agentId: string;
  prompt: string;
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

export interface QueueMetrics {
  agentId: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  concurrency: number;
  mode: 'bullmq' | 'semaphore';
}

type TaskExecutionResult = {
  success: boolean;
  output: string;
  error?: string;
  status?: 'completed' | 'failed' | 'timed_out' | 'cancelled';
  evidenceJson?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};
type TaskExecutor = (task: QueuedTask, signal: AbortSignal) => Promise<TaskExecutionResult>;

type VerifierResult = {
  type: 'run';
  command: string;
  timeoutMs: number;
  startedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  passed: boolean;
  outputSnippet: string;
  spawnError?: string;
};

function loadTaskMetadata(taskId: string): Record<string, unknown> {
  const row = getDb().prepare('SELECT metadata_json FROM tasks WHERE id=?').get(taskId) as { metadata_json: string | null } | undefined;
  if (!row?.metadata_json) return {};
  try {
    const parsed = JSON.parse(row.metadata_json) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persistTaskEscalation(taskId: string, agentId: string, metadataPatch: { attemptedAgents: string[]; escalationHistory: unknown[] }): void {
  const db = getDb();
  const metadata = {
    ...loadTaskMetadata(taskId),
    ...metadataPatch,
  };
  db.prepare(`
    UPDATE tasks
    SET assigned_to=?, metadata_json=?, updated_at=datetime('now')
    WHERE id=?
  `).run(agentId, JSON.stringify(metadata), taskId);
}

const SILENT_FAILURE_PATTERN = /usage limit|rate limit exceeded|quota exceeded|user not found|unauthorized|invalid api key|\b401\b|payment required|credit/i;

export function classifyResult(result: TaskExecutionResult): TaskExecutionResult {
  if (!result.success) return result;

  const output = result.output ?? '';
  const trimmed = output.trim();

  if (trimmed.length === 0) {
    return { ...result, success: false, output, error: 'silent-failure: empty output' };
  }

  if (trimmed === '(에이전트 응답 없음)') {
    return { ...result, success: false, output, error: 'silent-failure: no agent response' };
  }

  if (output.length < 300 && SILENT_FAILURE_PATTERN.test(output)) {
    return { ...result, success: false, output, error: 'silent-failure: limit or credential message' };
  }

  return result;
}

function mergeVerifierOutput(stdout: string, stderr: string): string {
  return `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.slice(0, 2000);
}

function persistVerifierResult(taskId: string, verifierResult: VerifierResult): void {
  const db = getDb();
  db.prepare(`
    UPDATE tasks
    SET verifier_result_json=?, updated_at=datetime('now')
    WHERE id=?
  `).run(JSON.stringify(verifierResult), taskId);
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

export async function applyVerifierGate(
  task: QueuedTask,
  classified: TaskExecutionResult,
  controllerSignal: AbortSignal,
): Promise<TaskExecutionResult> {
  if (!classified.success) {
    return classified;
  }

  // P1-6 evidence-gate opt-in 하드차단: 태스크가 metadata_json.requiredEvidence를 선언하면
  // 해당 증거가 모두 있어야 성공. 없으면 completed→failed 강등(evidence_gate_blocked).
  // 선언 없으면(기본) 완전 무영향.
  try {
    const row = getDb().prepare('SELECT metadata_json FROM tasks WHERE id=?').get(task.taskId) as { metadata_json: string | null } | undefined;
    const requiredKinds = row?.metadata_json ? (JSON.parse(row.metadata_json)?.requiredEvidence ?? []) : [];
    if (Array.isArray(requiredKinds) && requiredKinds.length > 0) {
      const extracted = extractTaskEvidenceJson(classified.output || '');
      const gate = requireEvidence(extracted.evidenceJson ?? {}, requiredKinds);
      if (!gate.allowed) {
        return {
          ...classified,
          success: false,
          status: 'failed',
          error: [classified.error, `evidence_gate_blocked: missing ${gate.missing.join(', ')}`].filter(Boolean).join('\n\n'),
        };
      }
    }
  } catch (err) {
    log.warn({ taskId: task.taskId, err: (err as Error).message }, 'evidence gate check failed (non-fatal)');
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
    const child = spawn(binary, args, {
      cwd: env.PROJECT_DIR,
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: controllerSignal,
    });
    const { code, stdout, stderr, timedOut } = await waitForExitWithTimeout(child, timeoutMs);
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
    try {
      persistVerifierResult(task.taskId, verifierResult);
    } catch (err) {
      log.warn({ taskId: task.taskId, err }, 'Failed to persist verifier result');
    }

    if (passed) {
      return classified;
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
class Semaphore {
  private limit: number;
  private inUse = 0;
  private queue: Array<() => void> = [];

  constructor(concurrency: number) {
    this.limit = Math.max(1, concurrency);
  }

  async acquire(): Promise<void> {
    if (this.inUse < this.limit) {
      this.inUse++;
      return;
    }
    await new Promise<void>(resolve => this.queue.push(resolve));
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
    while (this.queue.length > 0 && this.inUse < this.limit) {
      this.inUse++;
      const next = this.queue.shift()!;
      next();
    }
  }
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
}

type LivenessState = 'working' | 'stalled' | 'dead';

interface TaskRuntimeEntry {
  taskId: string;
  agentId: string;
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
  abortReason?: 'cancelled' | 'timeout(idle)' | 'timeout(hardcap)' | 'timeout(first-activity)';
}

// ─── TaskQueueManager ─────────────────────────────────
class TaskQueueManager {
  private agents = new Map<string, AgentQueueEntry>();
  private executor: TaskExecutor | null = null;
  private initialized = false;
  private runtimes = new Map<string, TaskRuntimeEntry>();
  private monitorTimer: ReturnType<typeof setInterval> | null = null;

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
    return effective;
  }

  /**
   * Register the function that actually runs a task.
   * Called once during boot with agentManager.executeTask.
   */
  setExecutor(fn: TaskExecutor): void {
    this.executor = fn;
  }

  /**
   * Initialize queues for all enabled providers.
   * Safe to call even if Redis is offline — falls back to semaphore mode.
   */
  async init(providers: ProviderConfig[]): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    setInterval(async () => {
      for (const [, entry] of this.agents) {
        if (entry.mode !== "bullmq" || !entry.queue) continue;
        try {
          const waiting = await entry.queue.getWaiting();
          for (const job of waiting) {
            const waitMs = Date.now() - job.timestamp;
            if (waitMs > 300_000) {
              const cur = job.opts.priority ?? 5;
              await job.changePriority({ priority: Math.max(0, cur - 1) });
            }
          }
        } catch { }
      }
    }, 60_000);

    this.monitorTimer = setInterval(() => {
      for (const runtime of this.runtimes.values()) {
        this.monitorRuntime(runtime);
      }
    }, TASK_MONITOR_INTERVAL_MS);

    const redisAvailable = isRedisConnected();

    for (const p of providers) {
      const concurrency = Math.max(1, p.concurrency ?? 1);
      const effectiveConcurrency = this.getEffectiveConcurrency(p.id, concurrency);
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
      };

      if (redisAvailable) {
        try {
          await this.setupBullMQ(p.id, concurrency, entry);
          entry.mode = 'bullmq';
        } catch (err: any) {
          log.warn({ agentId: p.id, err: err.message }, 'BullMQ init failed — falling back to semaphore');
        }
      }

      this.agents.set(p.id, entry);
      log.info({ agentId: p.id, concurrency, mode: entry.mode }, 'Agent queue ready');
    }
  }

  private async setupBullMQ(agentId: string, concurrency: number, entry: AgentQueueEntry): Promise<void> {
    const redis = await getRedis();
    const connection = { host: redis.options.host || '127.0.0.1', port: Number(redis.options.port || 6379) };
    const queueName = `nco-agent-${agentId}`;

    entry.queue = new Queue<QueuedTask>(queueName, { connection });
    entry.queueEvents = new QueueEvents(queueName, { connection });

    entry.worker = new Worker<QueuedTask>(
      queueName,
      async (job: Job<QueuedTask>) => {
        return this.runJob(job.data, entry);
      },
      { connection, concurrency },
    );

    log.debug({ agentId, concurrency }, 'BullMQ queue+worker created');
  }

  private async runJob(task: QueuedTask, entry: AgentQueueEntry): Promise<TaskExecutionResult> {
    if (!this.executor) throw new Error('Executor not set');

    this.refreshEntryConcurrency(task.agentId, entry);
    await entry.semaphore.acquire();

    const controller = new AbortController();
    this.startRuntime(task, controller);
    entry.activeControllers.set(task.taskId, controller);
    entry.active++;

    const invocationId = task.metadata?.invocationId as string | undefined;
    if (invocationId) {
      invocationTracker.startInvocation(invocationId);
    }

    try {
      const result = await this.executor(task, controller.signal);
      const finalized = this.finalizeRuntime(task.taskId, result);
      const classified = classifyResult(finalized);
      const gated = await applyVerifierGate(task, classified, controller.signal);
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
      entry.activeControllers.delete(task.taskId);
      entry.active = Math.max(0, entry.active - 1);
      entry.semaphore.release();
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
    let lastError = '';
    let currentAgentId = task.agentId;
    let currentMetadata: Record<string, unknown> = { ...(task.metadata ?? {}) };
    let attemptedAgents = getAttemptedAgents(currentMetadata, task.agentId);
    let stallRetried = false;
    const allowStallRetry = process.env.NCO_STALL_RETRY !== '0';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Mark rate-limited in DB if this is a retry
      if (attempt > 0) {
        const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
        log.info({ taskId: task.taskId, agentId: currentAgentId, attempt, backoffMs }, 'Rate limit retry');
        this.markRateLimited(currentAgentId);
        await new Promise(r => setTimeout(r, backoffMs));

        // Try to failover after first retry
        if (attempt >= 2) {
          const failover = this.findFailoverAgent(currentAgentId, task.agentId);
          if (failover) {
            log.info({ taskId: task.taskId, from: currentAgentId, to: failover }, 'Failing over to alternate agent');
            currentAgentId = failover;
            attemptedAgents = appendAttemptedAgent(attemptedAgents, failover);
          }
        }
      }

      const result = await this.runEnqueue({ ...task, agentId: currentAgentId, metadata: currentMetadata });

      if (result.success) return result;
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
        const escalated = await this.tryTierEscalation(task, currentAgentId, errMsg, attemptedAgents, currentMetadata, 'non-rate-limit failure');
        if (escalated) return escalated;
        return result;
      }

      lastError = errMsg;
      log.warn({ taskId: task.taskId, agentId: currentAgentId, attempt }, 'Rate limit hit — will retry');
    }

    const escalated = await this.tryTierEscalation(task, currentAgentId, lastError, attemptedAgents, currentMetadata, 'rate limit exhaustion');
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
  ): Promise<TaskExecutionResult | null> {
    try {
      const escalation = decideFinalEscalation({
        failedAgentId,
        failureReason,
        attemptedAgents,
        circuitOpenAgents: circuitBreakerRegistry
          .listSnapshots()
          .filter(snapshot => snapshot.state === 'open')
          .map(snapshot => snapshot.agentId),
        metadata: currentMetadata,
      });
      if (escalation.action === 'escalate' && escalation.nextAgentId && escalation.metadataPatch) {
        const nextMetadata = {
          ...currentMetadata,
          ...escalation.metadataPatch,
        };
        persistTaskEscalation(task.taskId, escalation.nextAgentId, escalation.metadataPatch);
        log.info({
          taskId: task.taskId,
          from: failedAgentId,
          to: escalation.nextAgentId,
          reason: escalation.reason,
        }, `Escalating task after ${context}`);
        return await this.runEnqueue({
          ...task,
          agentId: escalation.nextAgentId,
          metadata: nextMetadata,
        });
      }
    } catch (err) {
      log.warn({ taskId: task.taskId, err: err instanceof Error ? err.message : String(err) }, `Escalation decision failed after ${context}`);
    }
    return null;
  }

  /** Mark an agent as rate-limited in the DB so smart-router skips it */
  private markRateLimited(agentId: string): void {
    try {
      const db = getDb();
      // Rate limit expires in 60 seconds by default
      db.prepare(`
        INSERT INTO rate_limit_state (agent_id, is_limited, reset_at, updated_at)
        VALUES (?, 1, datetime('now', '+60 seconds'), datetime('now'))
        ON CONFLICT(agent_id) DO UPDATE SET
          is_limited=1,
          reset_at=datetime('now', '+60 seconds'),
          updated_at=datetime('now')
      `).run(agentId);
    } catch { /* table may not exist yet */ }
  }

  /** Find an available agent to failover to */
  private findFailoverAgent(currentAgentId: string, originalAgentId: string): string | null {
    const providers = loadEnabledProviders();
    // Prefer free/local agents, exclude rate-limited ones
    try {
      const db = getDb();
      const limited = new Set(
        (db.prepare(`SELECT agent_id FROM rate_limit_state WHERE is_limited=1 AND reset_at > datetime('now')`).all() as any[])
          .map((r: any) => r.agent_id)
      );

      const candidates = providers
        .filter(p => p.id !== currentAgentId && p.id !== originalAgentId && !limited.has(p.id))
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
    // Auto-init unknown agents (e.g. dynamic providers)
    if (!this.agents.has(task.agentId)) {
      const providers = loadEnabledProviders();
      const p = providers.find(x => x.id === task.agentId);
      const concurrency = p?.concurrency ?? 1;
      const effectiveConcurrency = this.getEffectiveConcurrency(task.agentId, concurrency);
      this.agents.set(task.agentId, {
        semaphore: new Semaphore(effectiveConcurrency),
        configuredConcurrency: concurrency,
        concurrency: effectiveConcurrency,
        activeControllers: new Map(),
        mode: 'semaphore',
        waiting: 0, active: 0, completed: 0, failed: 0,
      });
    }

    const entry = this.agents.get(task.agentId)!;

    if (entry.mode === 'bullmq' && entry.queue) {
      return this.enqueueBullMQ(task, entry);
    }
    return this.enqueueSemaphore(task, entry);
  }

  private async enqueueBullMQ(task: QueuedTask, entry: AgentQueueEntry): Promise<TaskExecutionResult> {
    const job = await entry.queue!.add(task.taskId, task, {
      jobId: task.taskId,
      removeOnComplete: 100,
      removeOnFail: 50,
      priority: task.priority ?? 5,
      attempts: 3,
    });
    entry.waiting++;
    let leftWaiting = false;

    try {
      await this.waitForJobActive(job, entry.queueEvents!);
      entry.waiting = Math.max(0, entry.waiting - 1);
      leftWaiting = true;
      const result = await job.waitUntilFinished(
        entry.queueEvents!,
        this.getBullWaitTimeoutMs(task.timeoutMs),
      );
      entry.completed++;
      return result as { success: boolean; output: string };
    } catch (err: any) {
      // waiting 감소는 대기 이탈 시 1회만 — active 진입 후 실행 실패에서 이중 감소 금지 (리뷰 MED)
      if (!leftWaiting) entry.waiting = Math.max(0, entry.waiting - 1);
      entry.failed++;
      return { success: false, output: '', error: err.message };
    }
  }

  private async waitForJobActive(
    job: Job<QueuedTask>,
    queueEvents: QueueEvents,
    maxWaitMs = this.getQueueWaitMaxMs(),
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        queueEvents.off('active', onActive);
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

      queueEvents.on('active', onActive);
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

  private async enqueueSemaphore(task: QueuedTask, entry: AgentQueueEntry): Promise<TaskExecutionResult> {
    if (!this.executor) return { success: false, output: '', error: 'Executor not set' };

    entry.waiting++;
    this.refreshEntryConcurrency(task.agentId, entry);
    await entry.semaphore.acquire();
    entry.waiting = Math.max(0, entry.waiting - 1);

    const controller = new AbortController();
    this.startRuntime(task, controller);
    entry.activeControllers.set(task.taskId, controller);
    entry.active++;

    const invocationId = task.metadata?.invocationId as string | undefined;
    if (invocationId) {
      invocationTracker.startInvocation(invocationId);
    }

    try {
      const result = await this.executor(task, controller.signal);
      const finalized = this.finalizeRuntime(task.taskId, result);
      const classified = classifyResult(finalized);
      const gated = await applyVerifierGate(task, classified, controller.signal);
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
      entry.activeControllers.delete(task.taskId);
      entry.active = Math.max(0, entry.active - 1);
      entry.semaphore.release();
    }
  }

  /**
   * Abort a running task. Works for both BullMQ and semaphore modes.
   * - If queued (not yet active): remove from BullMQ queue
   * - If active: send AbortSignal to the running process
   */
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

      // Try to remove from BullMQ queue (still waiting)
      if (entry.queue) {
        try {
          const job = await entry.queue.getJob(taskId);
          if (job) {
            await job.remove();
            entry.waiting = Math.max(0, entry.waiting - 1);
            log.info({ agentId, taskId }, 'Task removed from queue (waiting)');
            return true;
          }
        } catch { /* job may have already started */ }
      }
    }
    return false;
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
          waiting = await entry.queue.getWaitingCount();
          active = await entry.queue.getActiveCount();
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

  async close(): Promise<void> {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    for (const entry of this.agents.values()) {
      if (entry.worker) await entry.worker.close();
      if (entry.queue) await entry.queue.close();
      if (entry.queueEvents) await entry.queueEvents.close();
    }
    this.agents.clear();
  }

  recordActivity(taskId: string, chunk?: string): void {
    const runtime = this.runtimes.get(taskId);
    if (!runtime) return;
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
    this.flushActivityToDb(runtime, chunk);
  }

  recordChildProcess(taskId: string, pid: number | null | undefined): void {
    const runtime = this.runtimes.get(taskId);
    if (!runtime || !pid || pid <= 0) return;
    runtime.childPid = pid;
    runtime.processAlive = true;
    this.recordActivity(taskId);
  }

  getTaskSnapshot(taskId: string): { lastActivityAt: string | null; liveness: LivenessState } {
    const runtime = this.runtimes.get(taskId);
    if (!runtime) {
      const row = getDb().prepare('SELECT last_activity_at FROM tasks WHERE id=?').get(taskId) as { last_activity_at?: string | null } | undefined;
      return { lastActivityAt: row?.last_activity_at ?? null, liveness: 'dead' };
    }
    return {
      lastActivityAt: new Date(runtime.lastActivityAt).toISOString(),
      liveness: runtime.liveness,
    };
  }

  getAbortReason(taskId: string): TaskRuntimeEntry['abortReason'] | undefined {
    return this.runtimes.get(taskId)?.abortReason;
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
    return Number.isFinite(raw) && raw > 0 ? raw : 1_800_000;
  }

  private getBullWaitTimeoutMs(taskTimeoutMs?: number): number {
    return this.getHardTimeoutMs(taskTimeoutMs) + 30_000;
  }

  private startRuntime(task: QueuedTask, controller: AbortController): void {
    const now = Date.now();
    const runtime: TaskRuntimeEntry = {
      taskId: task.taskId,
      agentId: task.agentId,
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
    this.runtimes.set(task.taskId, runtime);
    acknowledgeTaskLease(task.taskId);
    this.flushActivityToDb(runtime);
  }

  private finalizeRuntime(taskId: string, result: TaskExecutionResult): TaskExecutionResult {
    const runtime = this.runtimes.get(taskId);
    if (!runtime) return result;
    this.flushActivityToDb(runtime);
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
    return { ...result, success, output, error, status };
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
    return evidence.evidenceJson
      ? { ...terminal, evidenceJson: evidence.evidenceJson }
      : terminal;
  }

  private flushActivityToDb(runtime: TaskRuntimeEntry, chunk?: string): void {
    const now = Date.now();
    if (!chunk && now - runtime.lastDbFlushAt < 1_000) return;
    runtime.lastDbFlushAt = now;
    getDb().prepare(`
      UPDATE tasks
      SET last_activity_at=?, updated_at=datetime('now')
      WHERE id=?
    `).run(new Date(runtime.lastActivityAt).toISOString(), runtime.taskId);
    if (runtime.firstActivityObserved && now - runtime.lastHeartbeatFlushAt >= 1_000) {
      runtime.lastHeartbeatFlushAt = now;
      recordTaskHeartbeat(runtime.taskId);
    }
  }

  private monitorRuntime(runtime: TaskRuntimeEntry): void {
    if (runtime.abortReason) return;
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
  }
}

export const taskQueue = new TaskQueueManager();

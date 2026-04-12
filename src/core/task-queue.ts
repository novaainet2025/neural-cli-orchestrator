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
import { isRedisConnected, getRedis } from '../storage/redis.js';
import { loadEnabledProviders, type ProviderConfig } from '../utils/config.js';
import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';
import { invocationTracker } from './invocation-tracker.js';

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

const log = createLogger('task-queue');

// ─── Types ────────────────────────────────────────────
export interface QueuedTask {
  taskId: string;
  agentId: string;
  prompt: string;
  systemPrompt?: string;
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

type TaskExecutor = (task: QueuedTask, signal: AbortSignal) => Promise<{ success: boolean; output: string; error?: string }>;

// ─── In-memory semaphore (Redis-offline fallback) ─────
class Semaphore {
  private slots: number;
  private queue: Array<() => void> = [];

  constructor(concurrency: number) {
    this.slots = Math.max(1, concurrency);
  }

  async acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--;
      return;
    }
    await new Promise<void>(resolve => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.slots++;
    }
  }
}

// ─── Per-agent queue entry ─────────────────────────────
interface AgentQueueEntry {
  queue?: Queue;
  worker?: Worker;
  semaphore: Semaphore;      // always present as fallback
  concurrency: number;
  activeControllers: Map<string, AbortController>; // taskId → controller
  mode: 'bullmq' | 'semaphore';
  // For semaphore mode: track waiting/active counts
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

// ─── TaskQueueManager ─────────────────────────────────
class TaskQueueManager {
  private agents = new Map<string, AgentQueueEntry>();
  private executor: TaskExecutor | null = null;
  private initialized = false;

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

    const redisAvailable = isRedisConnected();

    for (const p of providers) {
      const concurrency = Math.max(1, p.concurrency ?? 1);
      const entry: AgentQueueEntry = {
        semaphore: new Semaphore(concurrency),
        concurrency,
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
    const queueName = `nco:agent:${agentId}`;

    entry.queue = new Queue<QueuedTask>(queueName, { connection });

    entry.worker = new Worker<QueuedTask>(
      queueName,
      async (job: Job<QueuedTask>) => {
        return this.runJob(job.data, entry);
      },
      { connection, concurrency },
    );

    entry.worker.on('completed', () => { entry.completed++; });
    entry.worker.on('failed', () => { entry.failed++; });

    log.debug({ agentId, concurrency }, 'BullMQ queue+worker created');
  }

  private async runJob(task: QueuedTask, entry: AgentQueueEntry): Promise<{ success: boolean; output: string }> {
    if (!this.executor) throw new Error('Executor not set');

    const controller = new AbortController();
    entry.activeControllers.set(task.taskId, controller);
    entry.active++;

    const invocationId = task.metadata?.invocationId as string | undefined;
    if (invocationId) {
      invocationTracker.startInvocation(invocationId);
    }

    try {
      const result = await this.executor(task, controller.signal);
      if (invocationId) {
        const summary = (result.output || '').slice(0, 500);
        invocationTracker.completeInvocation(
          invocationId,
          result.success ? 'completed' : 'failed',
          result.success ? summary : undefined,
          result.success ? undefined : (result.error || result.output),
        );
        await invocationTracker.notifyCompletion(invocationId);
      }
      return result;
    } catch (err: any) {
      if (invocationId) {
        invocationTracker.completeInvocation(invocationId, 'failed', undefined, err.message);
        await invocationTracker.notifyCompletion(invocationId);
      }
      throw err;
    } finally {
      entry.activeControllers.delete(task.taskId);
      entry.active = Math.max(0, entry.active - 1);
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
  async enqueue(task: QueuedTask): Promise<{ success: boolean; output: string; error?: string }> {
    let lastError = '';
    let currentAgentId = task.agentId;

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
          }
        }
      }

      const result = await this.runEnqueue({ ...task, agentId: currentAgentId });

      if (result.success) return result;

      // Check if failure was rate limit related
      const errMsg = result.error || result.output || '';
      if (!isRateLimitError(errMsg)) {
        // Non-rate-limit failure — don't retry
        return result;
      }

      lastError = errMsg;
      log.warn({ taskId: task.taskId, agentId: currentAgentId, attempt }, 'Rate limit hit — will retry');
    }

    return { success: false, output: '', error: `Rate limit exhausted after ${MAX_RETRIES} retries: ${lastError}` };
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
  private async runEnqueue(task: QueuedTask): Promise<{ success: boolean; output: string; error?: string }> {
    // Auto-init unknown agents (e.g. dynamic providers)
    if (!this.agents.has(task.agentId)) {
      const providers = loadEnabledProviders();
      const p = providers.find(x => x.id === task.agentId);
      const concurrency = p?.concurrency ?? 1;
      this.agents.set(task.agentId, {
        semaphore: new Semaphore(concurrency),
        concurrency,
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

  private async enqueueBullMQ(task: QueuedTask, entry: AgentQueueEntry): Promise<{ success: boolean; output: string; error?: string }> {
    const job = await entry.queue!.add(task.taskId, task, {
      jobId: task.taskId,
      removeOnComplete: 100,
      removeOnFail: 50,
      priority: task.priority ?? 5,
      attempts: 3,
    });
    entry.waiting++;

    try {
      // Wait for job to complete via QueueEvents
      const result = await job.waitUntilFinished(
        new QueueEvents(`nco:agent:${task.agentId}`, {
          connection: { host: (await getRedis()).options.host || '127.0.0.1', port: Number((await getRedis()).options.port || 6379) },
        }),
        300_000, // 5 min timeout
      );
      entry.waiting = Math.max(0, entry.waiting - 1);
      entry.completed++;
      return result as { success: boolean; output: string };
    } catch (err: any) {
      entry.waiting = Math.max(0, entry.waiting - 1);
      entry.failed++;
      return { success: false, output: '', error: err.message };
    }
  }

  private async enqueueSemaphore(task: QueuedTask, entry: AgentQueueEntry): Promise<{ success: boolean; output: string; error?: string }> {
    if (!this.executor) return { success: false, output: '', error: 'Executor not set' };

    entry.waiting++;
    await entry.semaphore.acquire();
    entry.waiting = Math.max(0, entry.waiting - 1);

    const controller = new AbortController();
    entry.activeControllers.set(task.taskId, controller);
    entry.active++;

    const invocationId = task.metadata?.invocationId as string | undefined;
    if (invocationId) {
      invocationTracker.startInvocation(invocationId);
    }

    try {
      const result = await this.executor(task, controller.signal);
      entry.completed++;
      if (invocationId) {
        const summary = (result.output || '').slice(0, 500);
        invocationTracker.completeInvocation(
          invocationId,
          result.success ? 'completed' : 'failed',
          result.success ? summary : undefined,
          result.success ? undefined : (result.error || result.output),
        );
        await invocationTracker.notifyCompletion(invocationId);
      }
      return result;
    } catch (err: any) {
      entry.failed++;
      if (invocationId) {
        invocationTracker.completeInvocation(invocationId, 'failed', undefined, err.message);
        await invocationTracker.notifyCompletion(invocationId);
      }
      return { success: false, output: '', error: err.message };
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
        controller.abort();
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
    for (const entry of this.agents.values()) {
      if (entry.worker) await entry.worker.close();
      if (entry.queue) await entry.queue.close();
    }
    this.agents.clear();
  }
}

export const taskQueue = new TaskQueueManager();

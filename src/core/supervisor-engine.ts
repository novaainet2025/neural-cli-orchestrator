import { readdir, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { execa } from 'execa';
import { env } from '../utils/config.js';
import { eventBus } from './event-bus.js';
import { createLogger } from '../utils/logger.js';
import { getDb } from '../storage/database.js';
import { kanbanEngine } from './kanban-engine.js';

const log = createLogger('supervisor-engine');

export class SupervisorEngine {
  private timer: NodeJS.Timeout | null = null;
  private stalledRecoveryTimer: NodeJS.Timeout | null = null;
  private intervalMs = 5 * 60 * 1000; // 5 minutes

  async start(): Promise<void> {
    log.info('Starting Supervisor Engine');
    if (this.timer) clearInterval(this.timer);
    if (this.stalledRecoveryTimer) clearInterval(this.stalledRecoveryTimer);
    this.timer = setInterval(() => this.runDiagnostics(), this.intervalMs);
    // Stalled task recovery runs every 2 minutes
    this.stalledRecoveryTimer = setInterval(() => this.recoverStalledTasks(), 2 * 60 * 1000);
    // Run once immediately (backgrounded)
    this.runDiagnostics().catch(err => log.error({ err }, 'Initial diagnostic failed'));
    this.recoverStalledTasks().catch(err => log.error({ err }, 'Initial stall recovery failed'));
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.stalledRecoveryTimer) {
      clearInterval(this.stalledRecoveryTimer);
      this.stalledRecoveryTimer = null;
    }
    log.info('Supervisor Engine stopped');
  }

  /**
   * Detect tasks stuck in 'assigned'/'running' or 'queued' for >10 minutes,
   * mark them as failed, and trigger auto-retry/requeue.
   * Also publishes a supervisor event so dashboard can reflect recovery.
   */
  private async recoverStalledTasks(): Promise<void> {
    try {
      const db = getDb();
      
      // 1. Find assigned/running tasks that are stalled (>10min)
      const stalledTasks = db.prepare(`
        SELECT id, assigned_to
        FROM tasks
        WHERE status IN ('assigned', 'running')
          AND (julianday('now') - julianday(COALESCE(last_activity_at, updated_at, created_at))) * 86400 > 600
      `).all() as { id: string; assigned_to: string | null }[];

      // 2. Find queued tasks that are stalled (>10min)
      const stalledQueuedTasks = db.prepare(`
        SELECT id, assigned_to
        FROM tasks
        WHERE status = 'queued'
          AND (julianday('now') - julianday(created_at)) * 86400 > 600
      `).all() as { id: string; assigned_to: string | null }[];

      const allStalled = [...stalledTasks, ...stalledQueuedTasks];

      if (allStalled.length === 0) return;

      log.warn({ count: allStalled.length }, 'Supervisor: Stalled tasks detected, initiating recovery');

      for (const task of allStalled) {
        const isQueued = stalledQueuedTasks.some(t => t.id === task.id);
        const errorMsg = isQueued
          ? 'Supervisor: auto-recovered stalled queued task (>10min)'
          : 'Supervisor: auto-recovered stalled task (>10min)';

        db.prepare(`
          UPDATE tasks
          SET status = 'failed',
              error = ?,
              updated_at = datetime('now'),
              completed_at = datetime('now')
          WHERE id = ?
        `).run(errorMsg, task.id);

        // Try to retry/requeue the task if the retry ref is registered
        if (kanbanEngine.createRetryTaskRef) {
          try {
            log.info({ taskId: task.id }, 'Supervisor: Triggering auto-retry for stalled task');
            const retryResult = await kanbanEngine.createRetryTaskRef(task.id);
            log.info({ taskId: task.id, retryResult }, 'Supervisor: Auto-retry triggered successfully');
          } catch (retryErr) {
            log.error({ taskId: task.id, err: (retryErr as Error).message }, 'Supervisor: Auto-retry failed for stalled task');
          }
        } else {
          log.warn({ taskId: task.id }, 'Supervisor: Cannot auto-retry task, createRetryTaskRef is not registered');
        }
      }

      await eventBus.publish({
        type: 'supervisor:stall-recovery',
        data: { recovered: allStalled.length, timestamp: Date.now() },
      } as any);
    } catch (err) {
      log.error({ err }, 'Stalled task recovery failed');
    }
  }

  private async runDiagnostics(): Promise<void> {
    log.debug('Running supervisor diagnostics...');
    try {
      const gapRate = await this.calculateGapRate();
      const health = await this.checkCodeHealth();

      const db = getDb();
      const stuckCountRow = db.prepare(`
        SELECT COUNT(*) as count
        FROM tasks
        WHERE (
          status IN ('assigned', 'running')
          AND (julianday('now') - julianday(COALESCE(last_activity_at, updated_at, created_at))) * 86400 > 600
        ) OR (
          status = 'queued'
          AND (julianday('now') - julianday(created_at)) * 86400 > 600
        )
      `).get() as { count: number } | undefined;
      const stuckTasksCount = stuckCountRow?.count ?? 0;

      await eventBus.publish({
        type: 'supervisor:report',
        data: {
          gapRate,
          health,
          stuckTasksCount,
          timestamp: Date.now(),
        },
      } as any);

      log.info({ gapRate, health, stuckTasksCount }, 'Supervisor diagnostic report published');
    } catch (err) {
      log.error({ err }, 'Diagnostic run failed');
    }
  }

  private async calculateGapRate(): Promise<number> {
    const plansDir = resolve(env.ROOT, 'docs/plans');
    try {
      if (!existsSync(plansDir)) return 0;
      const files = await readdir(plansDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));

      let totalTasks = 0;
      let completedTasks = 0;

      for (const file of mdFiles) {
        const content = await readFile(join(plansDir, file), 'utf-8');
        const tasks = content.match(/- \[[ xX]\]/g) || [];
        const completed = content.match(/- \[[xX]\]/g) || [];
        
        totalTasks += tasks.length;
        completedTasks += completed.length;
      }

      if (totalTasks === 0) return 0;
      return ((totalTasks - completedTasks) / totalTasks) * 100;
    } catch (err) {
      log.warn({ err }, 'Failed to read plans for gap rate calculation');
      return 0;
    }
  }

  private async checkCodeHealth(): Promise<{ tsc: boolean; eslint: boolean }> {
    const results = { tsc: true, eslint: true };

    // TSC Check
    try {
      const tsconfigPath = resolve(env.ROOT, 'tsconfig.json');
      if (existsSync(tsconfigPath)) {
        await execa('npx', ['tsc', '--noEmit'], { 
          cwd: env.ROOT, 
          timeout: 60_000,
          reject: true 
        });
      }
    } catch {
      results.tsc = false;
    }

    // ESLint Check
    try {
      const hasEslint = ['eslint.config.js', 'eslint.config.mjs', '.eslintrc.js', '.eslintrc.json']
        .some(f => existsSync(resolve(env.ROOT, f)));

      if (hasEslint) {
        await execa('npx', ['eslint', 'src', '--ext', '.ts,.tsx,.js,.jsx', '--max-warnings', '0'], {
          cwd: env.ROOT,
          timeout: 60_000,
          reject: true
        });
      }
    } catch {
      results.eslint = false;
    }

    return results;
  }
}

export const supervisorEngine = new SupervisorEngine();

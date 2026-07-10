/**
 * CronScheduler — Hermes/OpenClaw cron feature transplant
 * Persistent cron job management using node-cron + SQLite
 */

import * as nodeCron from 'node-cron';
import { createId } from '../utils/id.js';
import { getDb } from '../storage/database.js';
import { eventBus } from './event-bus.js';
import { createLogger } from '../utils/logger.js';
import { resolveInternalProjectDir } from '../utils/project-dir.js';

const log = createLogger('cron-scheduler');

export interface CronJobDef {
  id?: string;
  description?: string;
  /** Cron expression e.g. "0 9 * * 1-5" */
  schedule: string;
  /** Task type: nco_task | shell | webhook | internal */
  taskType?: 'nco_task' | 'shell' | 'webhook' | 'internal';
  /** JSON payload — {ai,prompt} for nco_task, {command} for shell, {url,method,body} for webhook */
  payload?: Record<string, unknown>;
  timezone?: string;
  maxRetries?: number;
  backoffMs?: number;
  enabled?: boolean;
}

export interface CronJobRecord extends Required<Omit<CronJobDef, 'id'>> {
  id: string;
  lastRunAt?: string;
  lastStatus?: string;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

// Active node-cron task references
const activeTasks = new Map<string, nodeCron.ScheduledTask>();
const retryTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();
let defaultInternalJobsEnsured = false;

function getDefaultTimezone(): string {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function trackRetryTimer(jobId: string, handle: ReturnType<typeof setTimeout>): void {
  const timers = retryTimers.get(jobId) ?? new Set<ReturnType<typeof setTimeout>>();
  timers.add(handle);
  retryTimers.set(jobId, timers);
}

function clearRetryTimers(jobId: string): void {
  const timers = retryTimers.get(jobId);
  if (!timers) return;
  for (const handle of timers) {
    clearTimeout(handle);
  }
  retryTimers.delete(jobId);
}

function isJobEnabled(jobId: string): boolean {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT enabled FROM cron_jobs WHERE id=?`).get(jobId) as { enabled?: number } | undefined;
    return row?.enabled === 1;
  } catch {
    return false;
  }
}

function scheduleRetry(job: CronJobRecord, attempt: number): void {
  const backoff = Math.max(job.backoffMs, 0);
  const handle = setTimeout(() => {
    retryTimers.get(job.id)?.delete(handle);
    if (!isJobEnabled(job.id)) {
      return;
    }
    void executeJob(job, attempt + 1);
  }, backoff);
  trackRetryTimer(job.id, handle);
}

async function executeJob(job: CronJobRecord, attempt = 1): Promise<void> {
  log.info({ jobId: job.id, taskType: job.taskType, attempt }, 'Cron job firing');
  const NCO_API = process.env.NCO_API_URL || 'http://localhost:6200';
  const TOKEN = process.env.NCO_API_TOKEN || 'nco_secret_key_change_me_in_production';

  try {
    let result: string;

    if (job.taskType === 'nco_task') {
      const { ai, prompt } = job.payload as { ai: string; prompt: string };
      const targetAi = ai || 'openrouter';

      // gate-awareness: quota/circuit로 gated된 프로바이더에 배정하면 즉시 실패한다.
      // 배정 전 gate.available을 확인하고, 불가하면 '실패'가 아니라 30분 지연 후 재시도한다.
      // (gate 조회 자체가 실패하면 기존 동작으로 폴백 — 게이트 확인이 크론을 막지 않도록)
      try {
        const gateRes = await fetch(`${NCO_API}/api/agents`, { signal: AbortSignal.timeout(5_000) });
        if (gateRes.ok) {
          const { agents } = await gateRes.json() as {
            agents: Array<{ id: string; gate?: { available?: boolean; status?: string } }>;
          };
          const target = agents.find(a => a.id === targetAi);
          if (target?.gate?.available === false) {
            updateJobStatus(job.id, 'delayed');
            const handle = setTimeout(() => {
              retryTimers.get(job.id)?.delete(handle);
              if (!isJobEnabled(job.id)) return;
              void executeJob(job);
            }, 30 * 60 * 1000);
            trackRetryTimer(job.id, handle);
            await eventBus.publish({
              type: 'cron:completed' as any,
              taskId: job.id,
              agentId: 'cron-scheduler',
              output: `skipped:gated:${targetAi}:${target.gate.status ?? 'gated'}`,
            });
            log.warn({ jobId: job.id, targetAi, gate: target.gate.status }, 'Cron target gated — delayed, not fired');
            return;
          }
        }
      } catch {
        // gate 조회 실패 → 폴백(발사)
      }

      const res = await fetch(`${NCO_API}/api/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          ai: targetAi,
          prompt,
          callerAgentId: 'cron-scheduler',
          metadata: { projectDir: resolveInternalProjectDir() },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      result = await res.text();

    } else if (job.taskType === 'shell') {
      const { execa } = await import('execa');
      const cmd = (job.payload as { command: string }).command;
      const r = await execa('bash', ['-c', cmd], { timeout: 30_000, reject: false });
      result = r.stdout || r.stderr || `exit ${r.exitCode}`;

    } else if (job.taskType === 'webhook') {
      const { url, method = 'POST', body = {} } = job.payload as { url: string; method?: string; body?: unknown };
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      result = `${res.status} ${res.statusText}`;

    } else if (job.taskType === 'internal') {
      const { action } = job.payload as { action?: string };
      if (action === 'sleep-consolidation') {
        const { sleepConsolidator } = await import('./sleep-consolidator.js');
        const gate = sleepConsolidator.getSelfImprovementGateStatus();
        if (!gate.ok) {
          updateJobStatus(job.id, 'delayed');
          const handle = setTimeout(() => {
            retryTimers.get(job.id)?.delete(handle);
            if (!isJobEnabled(job.id)) {
              return;
            }
            void executeJob(job);
          }, 60 * 60 * 1000);
          trackRetryTimer(job.id, handle);
          await eventBus.publish({
            type: 'cron:completed' as any,
            taskId: job.id,
            agentId: 'cron-scheduler',
            output: `delayed:${gate.reason}:activeTasks=${gate.activeTasks}`,
          });
          return;
        }

        const report = await sleepConsolidator.consolidateSelfImprovements();
        result = JSON.stringify(report);
      } else {
        throw new Error(`Unknown internal cron action: ${String(action)}`);
      }

    } else {
      throw new Error(`Unknown taskType: ${String(job.taskType)}`);
    }

    updateJobStatus(job.id, 'success');
    await eventBus.publish({ type: 'cron:completed' as any, taskId: job.id, agentId: 'cron-scheduler', output: result.slice(0, 500) });

  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    if (attempt < job.maxRetries) {
      log.warn({ jobId: job.id, attempt, err: message }, 'Cron job failed; retry scheduled');
      updateJobStatus(job.id, `retrying:${attempt}`);
      scheduleRetry(job, attempt);
      return;
    }

    log.error({ jobId: job.id, err: message }, 'Cron job failed');
    updateJobStatus(job.id, 'failed');
    await eventBus.publish({ type: 'cron:failed' as any, taskId: job.id, agentId: 'cron-scheduler', output: message });
  }
}

function updateJobStatus(id: string, status: string): void {
  try {
    const db = getDb();
    db.prepare(`
      UPDATE cron_jobs SET last_run_at=datetime('now'), last_status=?, run_count=run_count+1, updated_at=datetime('now')
      WHERE id=?
    `).run(status, id);
  } catch { /* ignore */ }
}

function startTask(job: CronJobRecord): void {
  if (!nodeCron.validate(job.schedule)) {
    log.warn({ jobId: job.id, schedule: job.schedule }, 'Invalid cron expression, skipping');
    return;
  }

  const task = nodeCron.schedule(job.schedule, () => {
    // 발사 시점에 DB에서 enabled를 재확인한다. disable()이 in-memory task.stop()을
    // 못 부른 경우(또는 다른 세션이 DB에서 disable한 경우)에도 비활성 크론이 발사되지
    // 않도록 방어한다. (retry/delay 경로는 이미 isJobEnabled를 체크함 — 발사 경로만 누락)
    if (!isJobEnabled(job.id)) return;
    void executeJob(job);
  }, {
    timezone: job.timezone || 'UTC',
  });

  activeTasks.set(job.id, task);
  log.info({ jobId: job.id, schedule: job.schedule }, 'Cron job scheduled');
}

function ensureDefaultInternalJobs(): void {
  if (defaultInternalJobsEnsured) {
    return;
  }
  defaultInternalJobsEnsured = true;

  if (getCronJob('sleep-self-improvement')) {
    return;
  }

  scheduleCronJob({
    id: 'sleep-self-improvement',
    description: 'WS5 sleep-time self-improvement consolidation',
    schedule: '0 3 * * *',
    taskType: 'internal',
    payload: { action: 'sleep-consolidation' },
    timezone: getDefaultTimezone(),
    maxRetries: 3,
    backoffMs: 60_000,
    enabled: true,
  });
}

// ─── Public API ─────────────────────────────────────────

export function scheduleCronJob(def: CronJobDef): CronJobRecord {
  const db = getDb();
  const id = def.id || createId();

  const record: CronJobRecord = {
    id,
    description: def.description || '',
    schedule: def.schedule,
    taskType: def.taskType || 'nco_task',
    payload: def.payload || {},
    timezone: def.timezone || 'UTC',
    maxRetries: def.maxRetries ?? 3,
    backoffMs: def.backoffMs ?? 5000,
    enabled: def.enabled ?? true,
    lastRunAt: undefined,
    lastStatus: undefined,
    runCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  db.prepare(`
    INSERT OR REPLACE INTO cron_jobs
      (id, description, schedule, task_type, payload, timezone, max_retries, backoff_ms, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, record.description, record.schedule, record.taskType, JSON.stringify(record.payload),
    record.timezone, record.maxRetries, record.backoffMs, record.enabled ? 1 : 0);

  if (record.enabled) {
    activeTasks.get(id)?.stop();
    clearRetryTimers(id);
    startTask(record);
  }

  log.info({ id, schedule: record.schedule }, 'Cron job created');
  return record;
}

export function cancelCronJob(id: string): boolean {
  const task = activeTasks.get(id);
  if (task) {
    task.stop();
    activeTasks.delete(id);
  }
  clearRetryTimers(id);

  try {
    const db = getDb();
    db.prepare(`UPDATE cron_jobs SET enabled=0, updated_at=datetime('now') WHERE id=?`).run(id);
  } catch { /* ignore */ }

  return !!task;
}

export function deleteCronJob(id: string): boolean {
  cancelCronJob(id);
  clearRetryTimers(id);
  try {
    const db = getDb();
    const r = db.prepare(`DELETE FROM cron_jobs WHERE id=?`).run(id);
    return r.changes > 0;
  } catch { return false; }
}

export function listCronJobs(): CronJobRecord[] {
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM cron_jobs ORDER BY created_at DESC`).all() as any[];
    return rows.map(r => ({
      id: r.id,
      description: r.description || '',
      schedule: r.schedule,
      taskType: r.task_type as CronJobRecord['taskType'],
      payload: JSON.parse(r.payload || '{}'),
      timezone: r.timezone,
      maxRetries: r.max_retries,
      backoffMs: r.backoff_ms,
      enabled: r.enabled === 1,
      lastRunAt: r.last_run_at,
      lastStatus: r.last_status,
      runCount: r.run_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  } catch { return []; }
}

export function getCronJob(id: string): CronJobRecord | null {
  try {
    const db = getDb();
    const r = db.prepare(`SELECT * FROM cron_jobs WHERE id=?`).get(id) as any;
    if (!r) return null;
    return {
      id: r.id, description: r.description || '', schedule: r.schedule,
      taskType: r.task_type as CronJobRecord['taskType'],
      payload: JSON.parse(r.payload || '{}'), timezone: r.timezone,
      maxRetries: r.max_retries, backoffMs: r.backoff_ms, enabled: r.enabled === 1,
      lastRunAt: r.last_run_at, lastStatus: r.last_status, runCount: r.run_count,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  } catch { return null; }
}

/** Load all enabled jobs from DB and start them (called on NCO boot) */
export function loadCronJobs(): void {
  ensureDefaultInternalJobs();
  const jobs = listCronJobs().filter(j => j.enabled);
  log.info({ count: jobs.length }, 'Loading persisted cron jobs');
  for (const job of jobs) {
    if (!activeTasks.has(job.id)) {
      startTask(job);
    }
  }
}

export function getActiveCronCount(): number {
  return activeTasks.size;
}

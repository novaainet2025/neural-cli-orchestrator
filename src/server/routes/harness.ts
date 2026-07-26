import type { FastifyInstance } from 'fastify';
import {
  getCompanyRun,
  startCompanyRun,
  type CompanyRun,
  type OrchestrationMode,
  OrchestrationError,
} from '../../core/company-orchestrator.js';
import { getDb } from '../../storage/database.js';
import { createId } from '../../utils/id.js';
import { resolveInternalProjectDir } from '../../utils/project-dir.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('harness-routes');
const DEFAULT_ORGANIZATION = 'nco-engineering';
const DEFAULT_MAX_ITERATIONS = 5;
const ABSOLUTE_MAX_ITERATIONS = 10;
const MAX_REQUIREMENT_LENGTH = 20_000;
const POLL_MS = 1_000;
const TERMINAL_COMPANY_STATUSES = new Set(['completed', 'partial', 'failed', 'planned']);
const ACTIVE_TRACKERS = new Set<string>();

export type HarnessStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed';

export interface HarnessReport {
  harnessId: string;
  requirement: string;
  organization: string;
  mode: OrchestrationMode;
  status: HarnessStatus;
  companyRunId: string | null;
  totalIterations: number;
  maxIterations: number;
  completionScore: number;
  converged: boolean;
  terminationReason: string | null;
  stages: Array<{
    team: string;
    executor: string;
    taskId: string | null;
    status: string;
    attempt: number;
    retries: number;
    outputChars: number;
    error: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface HarnessRow {
  id: string;
  requirement: string;
  organization: string;
  mode: OrchestrationMode;
  status: HarnessStatus;
  company_run_id: string | null;
  config_json: string;
  report_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function harnessStatus(run: CompanyRun | null): HarnessStatus {
  if (!run) return 'failed';
  if (run.status === 'completed') {
    return run.stages.every((stage) => stage.status === 'completed') ? 'completed' : 'partial';
  }
  if (run.status === 'partial') return 'partial';
  if (run.status === 'failed') return 'failed';
  return 'running';
}

export function buildHarnessReport(
  row: Pick<HarnessRow, 'id' | 'requirement' | 'organization' | 'mode' | 'company_run_id' | 'config_json' | 'created_at'>
    & Partial<Pick<HarnessRow, 'status' | 'updated_at' | 'completed_at'>>,
  run: CompanyRun | null,
  now = new Date().toISOString(),
): HarnessReport {
  let configuredMax = DEFAULT_MAX_ITERATIONS;
  try {
    const config = JSON.parse(row.config_json) as { maxIterations?: number };
    configuredMax = config.maxIterations ?? configuredMax;
  } catch {
    // Keep the safe default for legacy/corrupt config rows.
  }
  const stages = (run?.stages ?? []).map((stage) => ({
    team: stage.teamSlug,
    executor: stage.executor,
    taskId: stage.taskId,
    status: stage.status,
    attempt: stage.attempt ?? 1,
    retries: stage.retryCount ?? 0,
    outputChars: stage.outputChars ?? 0,
    error: stage.error ?? null,
  }));
  const completed = stages.filter((stage) => stage.status === 'completed').length;
  const completionScore = stages.length > 0 ? Math.round((completed / stages.length) * 100) : 0;
  const status = harnessStatus(run);
  const terminal = ['completed', 'partial', 'failed'].includes(status);
  const wasAlreadyTerminal = row.status !== undefined
    && ['completed', 'partial', 'failed'].includes(row.status);
  const converged = status === 'completed'
    && stages.length > 0
    && stages.every((stage) => stage.status === 'completed');
  const terminationReason = !terminal
    ? null
    : converged
      ? 'all_stages_verified'
      : run?.error ?? (status === 'partial' ? 'iteration_budget_exhausted_partial' : 'iteration_budget_exhausted');

  return {
    harnessId: row.id,
    requirement: row.requirement,
    organization: row.organization,
    mode: row.mode,
    status,
    companyRunId: row.company_run_id,
    totalIterations: run?.iteration ?? 0,
    maxIterations: run?.maxIterations ?? configuredMax,
    completionScore,
    converged,
    terminationReason,
    stages,
    createdAt: row.created_at,
    updatedAt: terminal && wasAlreadyTerminal
      ? row.updated_at ?? now
      : now,
    completedAt: terminal
      ? (wasAlreadyTerminal ? row.completed_at ?? now : now)
      : null,
  };
}

function persistReport(report: HarnessReport): void {
  const db = getDb();
  const reportJson = JSON.stringify(report);
  const terminal = ['completed', 'partial', 'failed'].includes(report.status);
  db.prepare(`
    UPDATE harness_runs
    SET status=?, report_json=?, updated_at=?, completed_at=?
    WHERE id=?
  `).run(
    report.status,
    reportJson,
    report.updatedAt,
    terminal ? report.completedAt : null,
    report.harnessId,
  );
  if (terminal) {
    db.prepare(`
      INSERT INTO harness_reports
        (id, requirement, status, total_iterations, final_avg_score, report_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,
        total_iterations=excluded.total_iterations,
        final_avg_score=excluded.final_avg_score,
        report_json=excluded.report_json
    `).run(
      report.harnessId,
      report.requirement.slice(0, 500),
      report.status,
      report.totalIterations,
      report.completionScore,
      reportJson,
      report.completedAt ?? report.updatedAt,
    );
  }
}

function readHarnessRow(id: string): HarnessRow | null {
  return (getDb().prepare('SELECT * FROM harness_runs WHERE id=?').get(id) as HarnessRow | undefined) ?? null;
}

function startTracker(harnessId: string): void {
  if (ACTIVE_TRACKERS.has(harnessId)) return;
  ACTIVE_TRACKERS.add(harnessId);

  const tick = (): void => {
    try {
      const row = readHarnessRow(harnessId);
      if (!row) {
        ACTIVE_TRACKERS.delete(harnessId);
        return;
      }
      const run = row.company_run_id ? getCompanyRun(row.company_run_id) : null;
      const report = buildHarnessReport(row, run);
      persistReport(report);
      if (run && TERMINAL_COMPANY_STATUSES.has(run.status)) {
        ACTIVE_TRACKERS.delete(harnessId);
        return;
      }
    } catch (error) {
      log.warn({
        harnessId,
        error: error instanceof Error ? error.message : String(error),
      }, 'Harness tracker tick failed');
    }
    const timer = setTimeout(tick, POLL_MS);
    timer.unref();
  };
  tick();
}

export function resumeHarnessRuns(): number {
  let rows: Array<{ id: string; company_run_id: string | null }> = [];
  try {
    rows = getDb().prepare(`
      SELECT id, company_run_id
      FROM harness_runs
      WHERE status IN ('queued','running')
      ORDER BY created_at ASC
    `).all() as Array<{ id: string; company_run_id: string | null }>;
  } catch (error) {
    throw new Error(
      `harness resume store unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const row of rows) {
    if (!row.company_run_id) {
      const full = readHarnessRow(row.id);
      if (full) persistReport(buildHarnessReport(full, null));
      continue;
    }
    startTracker(row.id);
  }
  return rows.length;
}

export async function registerHarnessRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/harness', async (req, reply) => {
    const body = (req.body as {
      requirement?: unknown;
      organization?: unknown;
      mode?: unknown;
      maxIterations?: unknown;
      projectDir?: unknown;
    } | null) ?? {};
    const requirement = typeof body.requirement === 'string' ? body.requirement.trim() : '';
    if (!requirement) return reply.code(400).send({ error: 'requirement must be a non-empty string' });
    if (requirement.length > MAX_REQUIREMENT_LENGTH) {
      return reply.code(400).send({ error: `requirement too long (max ${MAX_REQUIREMENT_LENGTH})` });
    }
    const organization = typeof body.organization === 'string' && body.organization.trim()
      ? body.organization.trim()
      : DEFAULT_ORGANIZATION;
    const mode: OrchestrationMode = body.mode === 'parallel' ? 'parallel' : 'pipeline';
    const requestedIterations = body.maxIterations === undefined
      ? DEFAULT_MAX_ITERATIONS
      : Number(body.maxIterations);
    if (!Number.isInteger(requestedIterations) || requestedIterations < 1 || requestedIterations > ABSOLUTE_MAX_ITERATIONS) {
      return reply.code(400).send({ error: `maxIterations must be an integer between 1 and ${ABSOLUTE_MAX_ITERATIONS}` });
    }
    const projectDir = typeof body.projectDir === 'string' && body.projectDir.trim()
      ? body.projectDir.trim()
      : resolveInternalProjectDir();
    const harnessId = createId('harness');
    const now = new Date().toISOString();
    const config = JSON.stringify({ maxIterations: requestedIterations, requiredCompletionScore: 100 });

    getDb().prepare(`
      INSERT INTO harness_runs
        (id, requirement, organization, mode, status, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(harnessId, requirement, organization, mode, config, now, now);

    try {
      const run = startCompanyRun(app, {
        orgIdOrSlug: organization,
        goal: requirement,
        mode,
        projectDir,
        maxIterations: requestedIterations,
      });
      getDb().prepare(`
        UPDATE harness_runs
        SET status='running', company_run_id=?, updated_at=?
        WHERE id=?
      `).run(run.id, new Date().toISOString(), harnessId);
      startTracker(harnessId);
      reply.code(202);
      return {
        harnessId,
        companyRunId: run.id,
        status: 'running',
        requiredCompletionScore: 100,
        maxIterations: requestedIterations,
      };
    } catch (error) {
      const row = readHarnessRow(harnessId);
      if (row) persistReport(buildHarnessReport(row, null));
      if (error instanceof OrchestrationError) {
        return reply.code(error.code).send({ error: error.message, harnessId });
      }
      return reply.code(500).send({
        error: error instanceof Error ? error.message : String(error),
        harnessId,
      });
    }
  });

  app.get('/api/harness', async (req) => {
    const rawLimit = Number((req.query as { limit?: string }).limit ?? 20);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 20, 100);
    const rows = getDb().prepare(`
      SELECT report_json
      FROM harness_runs
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Array<{ report_json: string }>;
    return {
      reports: rows.map((row) => {
        try { return JSON.parse(row.report_json); } catch { return null; }
      }).filter(Boolean),
    };
  });

  app.get<{ Params: { harnessId: string } }>('/api/harness/:harnessId', async (req, reply) => {
    const row = readHarnessRow(req.params.harnessId);
    if (!row) return reply.code(404).send({ error: 'Harness run not found' });
    const run = row.company_run_id ? getCompanyRun(row.company_run_id) : null;
    const report = buildHarnessReport(row, run);
    persistReport(report);
    return report;
  });
}

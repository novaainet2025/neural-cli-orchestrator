import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod/v4';
import {
  getKstPerformancePeriods,
  listActivePerformanceSubjects,
  PERFORMANCE_GOVERNANCE_SOURCE,
  runPerformanceGovernance,
} from '../../core/performance-governance.js';
import { runCommanderOperationAudit } from '../../core/commander-operation-audit.js';
import { getDb } from '../../storage/database.js';
import { getPerformanceDashboardHTML } from '../performance-dashboard.js';

const FlowQuerySchema = z.object({
  period: z.enum(['daily', 'weekly', 'monthly']).default('daily'),
  subjectKind: z.enum(['organization', 'team']).optional(),
  subjectId: z.string().min(1).max(160).optional(),
  limit: z.coerce.number().int().min(1).max(24).default(12),
});
const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

interface GovernanceMetrics {
  goal?: { attainmentPct?: number };
  execution?: {
    taskCompleted?: number;
    taskFailed?: number;
    terminalDenominator?: number;
  };
  workReports?: {
    due?: number;
    submitted?: number;
  };
  source?: { freshnessAt?: string };
}

interface PerformanceReportRow {
  subject_kind: 'organization' | 'team';
  subject_id: string;
  period: 'daily' | 'weekly' | 'monthly';
  period_key: string;
  metrics_json: string | null;
}

interface CommanderAuditRow {
  id: string;
  audit_time: string;
  source: string;
  status: string;
  checks_json: string;
  evidence_json: string;
  [key: string]: unknown;
}

export interface PerformanceFlowRouteDependencies {
  database?: () => Database.Database;
  runGovernance?: typeof runPerformanceGovernance;
  runAudit?: typeof runCommanderOperationAudit;
}

function parseMetrics(value: string | null): GovernanceMetrics {
  if (!value) return {};
  try {
    return JSON.parse(value) as GovernanceMetrics;
  } catch {
    return {};
  }
}

function percentage(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function parseAuditRow(row: CommanderAuditRow) {
  let checks: Record<string, unknown> = {};
  let evidence: string[] = [];
  try { checks = JSON.parse(row.checks_json) as Record<string, unknown>; } catch { /* preserve empty */ }
  try { evidence = JSON.parse(row.evidence_json) as string[]; } catch { /* preserve empty */ }
  const { checks_json: _checks, evidence_json: _evidence, ...rest } = row;
  return { ...rest, checks, evidence };
}

export function registerPerformanceFlowRoutes(
  app: FastifyInstance,
  dependencies: PerformanceFlowRouteDependencies = {},
): void {
  const database = dependencies.database ?? getDb;
  const executeGovernance = dependencies.runGovernance ?? runPerformanceGovernance;
  const executeAudit = dependencies.runAudit ?? runCommanderOperationAudit;

  app.get('/performance-flow', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(getPerformanceDashboardHTML());
  });

  app.get('/api/performance-flow', async (request, reply) => {
    const parsed = FlowQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', details: parsed.error.issues });
    }
    const query = parsed.data;
    const db = database();
    const subjects = listActivePerformanceSubjects(db)
      .filter(subject => !query.subjectKind || subject.kind === query.subjectKind)
      .filter(subject => !query.subjectId || subject.id === query.subjectId);
    const periodWindow = getKstPerformancePeriods()
      .find(window => window.period === query.period);
    if (!periodWindow) throw new Error(`Unknown period ${query.period}`);

    const where = [
      'source = ?',
      'period = ?',
    ];
    const params: Array<string | number> = [PERFORMANCE_GOVERNANCE_SOURCE, query.period];
    if (query.subjectKind) {
      where.push('subject_kind = ?');
      params.push(query.subjectKind);
    }
    if (query.subjectId) {
      where.push('subject_id = ?');
      params.push(query.subjectId);
    }
    const periodKeys = (db.prepare(`
      SELECT DISTINCT period_key
      FROM performance_reports
      WHERE ${where.join(' AND ')}
      ORDER BY period_key DESC
      LIMIT ?
    `).all(...params, query.limit) as Array<{ period_key: string }>)
      .map(row => row.period_key)
      .reverse();
    const rowsForPeriod = db.prepare(`
      SELECT subject_kind, subject_id, period, period_key, metrics_json
      FROM performance_reports
      WHERE ${where.join(' AND ')}
        AND period_key = ?
      ORDER BY subject_kind, subject_id
    `);
    const expectedSubjects = subjects.length;
    const series = periodKeys.map(periodKey => {
      const rows = rowsForPeriod.all(...params, periodKey) as PerformanceReportRow[];
      let goalAttainmentTotal = 0;
      let taskCompleted = 0;
      let failedTasks = 0;
      let terminalDenominator = 0;
      let workReportDue = 0;
      let workReportSubmitted = 0;
      let newestFreshness = '';
      for (const row of rows) {
        const metrics = parseMetrics(row.metrics_json);
        goalAttainmentTotal += Number(metrics.goal?.attainmentPct ?? 0);
        taskCompleted += Number(metrics.execution?.taskCompleted ?? 0);
        failedTasks += Number(metrics.execution?.taskFailed ?? 0);
        terminalDenominator += Number(metrics.execution?.terminalDenominator ?? 0);
        workReportDue += Number(metrics.workReports?.due ?? 0);
        workReportSubmitted += Number(metrics.workReports?.submitted ?? 0);
        if ((metrics.source?.freshnessAt ?? '') > newestFreshness) {
          newestFreshness = metrics.source?.freshnessAt ?? '';
        }
      }
      return {
        period: query.period,
        periodKey,
        subjectReports: rows.length,
        subjectReportCoveragePct: percentage(rows.length, expectedSubjects),
        goalAttainmentPct: rows.length > 0
          ? Math.round((goalAttainmentTotal / rows.length) * 100) / 100
          : 0,
        taskCompleted,
        failedTasks,
        taskSuccessRatePct: percentage(taskCompleted, terminalDenominator),
        workReportSubmitted,
        workReportDue,
        workReportSubmissionRatePct: percentage(workReportSubmitted, workReportDue),
        freshnessAt: newestFreshness || null,
      };
    });

    const goalExists = db.prepare(`
      SELECT 1 FROM team_goals
      WHERE subject_kind = ? AND subject_id = ?
        AND period = ? AND period_key = ? AND source = ?
      LIMIT 1
    `);
    const reportExists = db.prepare(`
      SELECT 1 FROM performance_reports
      WHERE subject_kind = ? AND subject_id = ?
        AND period = ? AND period_key = ? AND source = ?
      LIMIT 1
    `);
    let goalsPresent = 0;
    let reportsPresent = 0;
    for (const subject of subjects) {
      const args = [
        subject.kind,
        subject.id,
        query.period,
        periodWindow.key,
        PERFORMANCE_GOVERNANCE_SOURCE,
      ] as const;
      if (goalExists.get(...args)) goalsPresent++;
      if (reportExists.get(...args)) reportsPresent++;
    }

    return {
      generatedAt: new Date().toISOString(),
      timezone: 'Asia/Seoul',
      filters: query,
      subjects: listActivePerformanceSubjects(db).map(subject => ({
        kind: subject.kind,
        id: subject.id,
        name: subject.name,
      })),
      currentCoverage: {
        period: query.period,
        periodKey: periodWindow.key,
        subjectsExpected: expectedSubjects,
        goalsExpected: expectedSubjects,
        goalsPresent,
        goalCoveragePct: percentage(goalsPresent, expectedSubjects),
        reportsExpected: expectedSubjects,
        reportsPresent,
        reportCoveragePct: percentage(reportsPresent, expectedSubjects),
      },
      metricDefinitions: {
        goalAttainmentPct: '대상별 min(현재값/목표값, 100)의 산술평균',
        taskSuccessRatePct: '완료 / (완료 + 실패 + 시간초과 + 실제 실행 후 lease 만료)',
        workReportSubmissionRatePct: '제출 / 기간 내 기한이 도래한 waived 제외 업무보고',
        exclusions: ['cancelled 태스크', 'team_id가 없는 태스크'],
        sources: ['team_goals', 'tasks', 'work_reports', 'performance_reports'],
      },
      series,
    };
  });

  app.get('/api/commander/operations', async (request, reply) => {
    const parsed = AuditQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', details: parsed.error.issues });
    }
    const rows = database().prepare(`
      SELECT *
      FROM commander_operation_audits
      ORDER BY datetime(audit_time) DESC
      LIMIT ?
    `).all(parsed.data.limit) as CommanderAuditRow[];
    const history = rows.map(parseAuditRow);
    return { latest: history[0] ?? null, history };
  });

  app.post('/api/performance-governance/run', async () => {
    const db = database();
    const governance = executeGovernance({ database: db });
    const commanderAudit = executeAudit({
      database: db,
      source: 'manual',
    });
    return { governance, commanderAudit };
  });
}

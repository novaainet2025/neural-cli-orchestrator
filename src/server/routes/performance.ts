import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../../storage/database.js';
import { createId } from '../../utils/id.js';

// 성과보고 = 자동 지표(태스크 성공률·건수 + 목표 달성률) + 서술(반성·개선).
// 자동 지표는 tasks/team_goals에서 실시간 산정(T1), 서술은 performance_reports에 기록.

interface SubjectResolve { kind: 'organization' | 'team'; teamIds: string[] }

interface GoalMetric {
  id: string;
  period: string;
  periodKey: string;
  title: string;
  metric: string;
  currentValue: number;
  targetValue: number | null;
  unit: string;
  direction: string;
  attainment: number;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function resolveSubject(database: Database.Database, subjectId: string): SubjectResolve | null {
  const org = database.prepare('SELECT id FROM organizations WHERE id = ?').get(subjectId) as { id: string } | undefined;
  if (org) {
    const teams = database.prepare('SELECT id FROM teams WHERE organization_id = ?').all(subjectId) as Array<{ id: string }>;
    return { kind: 'organization', teamIds: teams.map(t => t.id) };
  }
  const team = database.prepare('SELECT id FROM teams WHERE id = ?').get(subjectId) as { id: string } | undefined;
  if (team) return { kind: 'team', teamIds: [subjectId] };
  return null;
}

function taskMetrics(database: Database.Database, teamIds: string[]): {
  taskCount: number;
  terminalCount: number;
  completed: number;
  failed: number;
  successRate: number;
  excludedFromRateCount: number;
  statusCounts: Record<string, number>;
} {
  if (!teamIds.length) {
    return {
      taskCount: 0,
      terminalCount: 0,
      completed: 0,
      failed: 0,
      successRate: 0,
      excludedFromRateCount: 0,
      statusCounts: {},
    };
  }
  const ph = teamIds.map(() => '?').join(',');
  const rows = database.prepare(
    `SELECT status, COUNT(*) c FROM tasks WHERE team_id IN (${ph}) AND created_at >= datetime('now','-14 days') GROUP BY status`
  ).all(...teamIds) as Array<{ status: string; c: number }>;
  let completed = 0, failed = 0, taskCount = 0;
  const statusCounts: Record<string, number> = {};
  for (const r of rows) {
    taskCount += r.c;
    statusCounts[r.status] = r.c;
    if (r.status === 'completed') completed += r.c;
    else if (['failed', 'timed_out', 'lease_expired'].includes(r.status)) failed += r.c;
  }
  const terminalCount = completed + failed;
  return {
    taskCount,
    terminalCount,
    completed,
    failed,
    successRate: terminalCount ? round2((completed / terminalCount) * 100) : 0,
    excludedFromRateCount: taskCount - terminalCount,
    statusCounts,
  };
}

function goalAttainment(database: Database.Database, subjectId: string): {
  count: number;
  metricCount: number;
  attainment: number;
  details: GoalMetric[];
} {
  const rows = database.prepare(`
    SELECT
      id, period, period_key, title, metric, current_value, target_value,
      unit, direction
    FROM team_goals
    WHERE subject_id = ? AND status = 'active'
    ORDER BY period ASC, period_key ASC, id ASC
  `).all(subjectId) as Array<{
    id: string;
    period: string;
    period_key: string;
    title: string;
    metric: string | null;
    current_value: number;
    target_value: number | null;
    unit: string | null;
    direction: string | null;
  }>;
  if (!rows.length) return { count: 0, metricCount: 0, attainment: 0, details: [] };
  const att = (cur: number, tgt: number | null, dir: string): number => {
    if (dir === 'decrease') {
      if (tgt == null) return cur <= 0 ? 100 : 0;
      if (cur <= tgt) return 100;
      if (tgt <= 0) return cur <= 0 ? 100 : 0;
      return Math.max(0, Math.min(100, round2((tgt / cur) * 100)));
    }
    if (tgt == null || tgt === 0) return cur > 0 ? 100 : 0;
    return Math.max(0, Math.min(100, round2((cur / tgt) * 100)));
  };
  const details = rows.map((row): GoalMetric => ({
    id: row.id,
    period: row.period,
    periodKey: row.period_key,
    title: row.title,
    metric: row.metric ?? 'unspecified',
    currentValue: row.current_value,
    targetValue: row.target_value,
    unit: row.unit ?? '',
    direction: row.direction ?? 'increase',
    attainment: att(row.current_value, row.target_value, row.direction ?? 'increase'),
  }));
  const uniqueMetrics = new Set(details.map((goal) => goal.metric));
  return {
    count: details.length,
    metricCount: uniqueMetrics.size,
    attainment: round2(details.reduce((sum, goal) => sum + goal.attainment, 0) / details.length),
    details,
  };
}

function buildPerformanceMetrics(
  database: Database.Database,
  subjectId: string,
  resolved: SubjectResolve,
): Record<string, unknown> {
  const tasks = taskMetrics(database, resolved.teamIds);
  const goals = goalAttainment(database, subjectId);
  // Backward-compatible reference score. Its inputs have different scopes
  // (14-day tasks vs active daily/weekly/monthly goals), so it is explicitly
  // marked non-comparable instead of being presented as a verified KPI.
  const composite = goals.count > 0
    ? round2(tasks.successRate * 0.6 + goals.attainment * 0.4)
    : tasks.successRate;
  const warnings: string[] = [];
  if (goals.count > goals.metricCount) {
    warnings.push(`활성 목표 ${goals.count}개가 ${goals.metricCount}개 KPI를 기간별로 반복 측정합니다.`);
  }
  if (goals.count > 0) {
    warnings.push('14일 태스크 성공률과 일·주·월 활성 목표 달성률은 집계 범위가 달라 직접 비교할 수 없습니다.');
  }
  if (tasks.successRate < 50 && goals.attainment >= 90) {
    warnings.push('낮은 태스크 성공률과 높은 목표 달성률이 동시에 존재합니다. 목표 KPI가 태스크 성공률이 아닌지 확인하십시오.');
  }
  const statusTotal = Object.values(tasks.statusCounts).reduce((sum, count) => sum + count, 0);
  return {
    subjectId,
    subjectKind: resolved.kind,
    taskCount: tasks.taskCount,
    terminalCount: tasks.terminalCount,
    completed: tasks.completed,
    failed: tasks.failed,
    successRate: tasks.successRate,
    excludedFromRateCount: tasks.excludedFromRateCount,
    taskStatusCounts: tasks.statusCounts,
    goalCount: goals.count,
    goalMetricCount: goals.metricCount,
    goalAttainment: goals.attainment,
    goalDetails: goals.details,
    compositeScore: composite,
    window: '14d',
    definitions: {
      taskSuccessRate: {
        formula: 'completed / (completed + failed + timed_out + lease_expired)',
        window: '최근 14일',
        numerator: tasks.completed,
        denominator: tasks.terminalCount,
        excludedStatuses: Object.keys(tasks.statusCounts)
          .filter((status) => !['completed', 'failed', 'timed_out', 'lease_expired'].includes(status)),
      },
      goalAttainment: {
        formula: '활성 목표별 min(현재값/목표값, 100)의 산술평균',
        population: "team_goals.status = 'active'",
        activeGoals: goals.count,
        distinctMetrics: goals.metricCount,
        periods: [...new Set(goals.details.map((goal) => goal.period))],
      },
      compositeScore: {
        formula: '태스크 성공률 × 0.6 + 활성 목표 달성률 × 0.4',
        comparable: goals.count === 0,
        status: goals.count === 0 ? 'verified-single-metric' : 'reference-only-mixed-scope',
      },
    },
    dataQuality: {
      taskStatusCountsReconciled: statusTotal === tasks.taskCount,
      terminalCountsReconciled: tasks.completed + tasks.failed === tasks.terminalCount,
      metricScopesAligned: goals.count === 0,
      warnings,
    },
  };
}

export function registerPerformanceRoutes(
  app: FastifyInstance,
  database: Database.Database = getDb(),
): void {
  // 자동 성과 지표 — 태스크 성공률 + 목표 달성률 (14일 창)
  app.get('/api/performance', async (req, reply) => {
    const q = (req.query as { subjectId?: string }) ?? {};
    if (!q.subjectId) return reply.code(400).send({ error: 'subjectId required' });
    const resolved = resolveSubject(database, q.subjectId);
    if (!resolved) return reply.code(404).send({ error: `subject not found: ${q.subjectId}` });
    return buildPerformanceMetrics(database, q.subjectId, resolved);
  });

  // 성과보고(서술) 목록
  app.get('/api/performance/reports', async (req) => {
    const q = (req.query as { subjectId?: string }) ?? {};
    const where = q.subjectId ? 'WHERE subject_id = ?' : '';
    const params = q.subjectId ? [q.subjectId] : [];
    const rows = database.prepare(
      `SELECT * FROM performance_reports ${where} ORDER BY created_at DESC LIMIT 50`
    ).all(...params) as Array<Record<string, unknown>>;
    return {
      reports: rows.map(r => ({
        id: r.id, subjectKind: r.subject_kind, subjectId: r.subject_id,
        period: r.period, periodKey: r.period_key,
        metrics: r.metrics_json ? JSON.parse(String(r.metrics_json)) : null,
        reflection: r.reflection, improvement: r.improvement, createdAt: r.created_at,
      })),
    };
  });

  // 성과보고 기록 — 자동 지표 스냅샷 + 반성·개선
  app.post('/api/performance/reports', async (req, reply) => {
    const b = (req.body as Record<string, unknown>) ?? {};
    const subjectId = typeof b.subjectId === 'string' ? b.subjectId.trim() : '';
    if (!subjectId) return reply.code(400).send({ error: 'subjectId required' });
    const resolved = resolveSubject(database, subjectId);
    if (!resolved) return reply.code(404).send({ error: `subject not found: ${subjectId}` });
    const period = ['daily', 'weekly', 'monthly'].includes(String(b.period)) ? String(b.period) : 'daily';
    const periodKey = typeof b.periodKey === 'string' && b.periodKey.trim() ? b.periodKey.trim() : new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const metrics = buildPerformanceMetrics(database, subjectId, resolved);
    const id = createId('perf');
    database.prepare(`
      INSERT INTO performance_reports (id, subject_kind, subject_id, period, period_key, metrics_json, reflection, improvement)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, resolved.kind, subjectId, period, periodKey, JSON.stringify(metrics),
      typeof b.reflection === 'string' ? b.reflection.slice(0, 2000) : null,
      typeof b.improvement === 'string' ? b.improvement.slice(0, 2000) : null);
    reply.code(201);
    return { id, subjectId, subjectKind: resolved.kind, period, periodKey, metrics };
  });
}

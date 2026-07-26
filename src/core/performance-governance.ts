import type Database from 'better-sqlite3';
import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('performance-governance');
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const PERFORMANCE_GOVERNANCE_SOURCE = 'performance-governance';
export const PERFORMANCE_PERIODS = ['daily', 'weekly', 'monthly'] as const;

export type PerformancePeriod = typeof PERFORMANCE_PERIODS[number];
export type PerformanceSubjectKind = 'organization' | 'team';

export interface PerformancePeriodWindow {
  period: PerformancePeriod;
  key: string;
  startAt: string;
  endAt: string;
}

export interface PerformanceSubject {
  kind: PerformanceSubjectKind;
  id: string;
  name: string;
  isAlwaysOn: boolean;
}

export interface PerformanceGovernanceResult {
  generatedAt: string;
  periodKeys: Record<PerformancePeriod, string>;
  activeOrganizations: number;
  activeTeams: number;
  goalsExpected: number;
  goalsCreated: number;
  goalsUpdated: number;
  goalsFinalized: number;
  reportsExpected: number;
  reportsCreated: number;
  reportsUpdated: number;
  missingGoalsAfter: number;
  missingReportsAfter: number;
}

interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  inProgress: number;
  terminalDenominator: number;
}

interface WorkReportStats {
  due: number;
  submitted: number;
  missed: number;
  overdue: number;
}

function dateFromKstParts(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day) - KST_OFFSET_MS);
}

function isoWeekKey(kstDate: Date): string {
  const local = new Date(Date.UTC(
    kstDate.getUTCFullYear(),
    kstDate.getUTCMonth(),
    kstDate.getUTCDate(),
  ));
  const day = local.getUTCDay() || 7;
  local.setUTCDate(local.getUTCDate() + 4 - day);
  const isoYear = local.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((local.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function getKstPerformancePeriods(now = new Date()): PerformancePeriodWindow[] {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const year = kst.getUTCFullYear();
  const month = kst.getUTCMonth();
  const day = kst.getUTCDate();
  const dayOfWeekFromMonday = (kst.getUTCDay() + 6) % 7;

  const dailyStart = dateFromKstParts(year, month, day);
  const weeklyLocalStart = new Date(Date.UTC(year, month, day - dayOfWeekFromMonday));
  const weeklyStart = dateFromKstParts(
    weeklyLocalStart.getUTCFullYear(),
    weeklyLocalStart.getUTCMonth(),
    weeklyLocalStart.getUTCDate(),
  );
  const monthlyStart = dateFromKstParts(year, month, 1);
  const nextMonthStart = dateFromKstParts(year, month + 1, 1);
  const dailyKey = [
    year,
    String(month + 1).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');

  return [
    {
      period: 'daily',
      key: dailyKey,
      startAt: dailyStart.toISOString(),
      endAt: new Date(dailyStart.getTime() + 86_400_000).toISOString(),
    },
    {
      period: 'weekly',
      key: isoWeekKey(kst),
      startAt: weeklyStart.toISOString(),
      endAt: new Date(weeklyStart.getTime() + 7 * 86_400_000).toISOString(),
    },
    {
      period: 'monthly',
      key: dailyKey.slice(0, 7),
      startAt: monthlyStart.toISOString(),
      endAt: nextMonthStart.toISOString(),
    },
  ];
}

export function listActivePerformanceSubjects(
  database: Database.Database,
): PerformanceSubject[] {
  const organizations = database.prepare(`
    SELECT id, name, COALESCE(is_always_on, 1) AS is_always_on
    FROM organizations
    WHERE is_active = 1
    ORDER BY id
  `).all() as Array<{ id: string; name: string; is_always_on: number }>;
  const teams = database.prepare(`
    SELECT t.id, t.name, COALESCE(t.is_always_on, 1) AS is_always_on
    FROM teams t
    LEFT JOIN organizations o ON o.id = t.organization_id
    WHERE t.is_active = 1
      AND (t.organization_id IS NULL OR o.is_active = 1)
    ORDER BY t.id
  `).all() as Array<{ id: string; name: string; is_always_on: number }>;

  return [
    ...organizations.map(row => ({
      kind: 'organization' as const,
      id: row.id,
      name: row.name,
      isAlwaysOn: row.is_always_on === 1,
    })),
    ...teams.map(row => ({
      kind: 'team' as const,
      id: row.id,
      name: row.name,
      isAlwaysOn: row.is_always_on === 1,
    })),
  ];
}

function taskStats(
  database: Database.Database,
  subject: PerformanceSubject,
  window: PerformancePeriodWindow,
): TaskStats {
  const subjectClause = subject.kind === 'team'
    ? 'k.team_id = ?'
    : 'k.team_id IN (SELECT id FROM teams WHERE organization_id = ? AND is_active = 1)';
  const row = database.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN k.status != 'cancelled' THEN 1 ELSE 0 END), 0) AS total,
      COALESCE(SUM(CASE WHEN k.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
      COALESCE(SUM(CASE WHEN k.status IN ('failed', 'timed_out', 'lease_expired') THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN k.status IN ('pending', 'queued', 'assigned', 'running', 'streaming', 'reviewing') THEN 1 ELSE 0 END), 0) AS in_progress,
      COALESCE(SUM(CASE WHEN k.status IN ('completed', 'failed', 'timed_out', 'lease_expired') THEN 1 ELSE 0 END), 0) AS terminal_denominator
    FROM tasks k
    WHERE ${subjectClause}
      AND datetime(COALESCE(k.completed_at, k.updated_at, k.created_at)) >= datetime(?)
      AND datetime(COALESCE(k.completed_at, k.updated_at, k.created_at)) < datetime(?)
  `).get(subject.id, window.startAt, window.endAt) as {
    total: number;
    completed: number;
    failed: number;
    in_progress: number;
    terminal_denominator: number;
  };
  return {
    total: row.total,
    completed: row.completed,
    failed: row.failed,
    inProgress: row.in_progress,
    terminalDenominator: row.terminal_denominator,
  };
}

function workReportStats(
  database: Database.Database,
  subject: PerformanceSubject,
  window: PerformancePeriodWindow,
  now: Date,
): WorkReportStats {
  const row = database.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status != 'waived' THEN 1 ELSE 0 END), 0) AS due,
      COALESCE(SUM(CASE WHEN submitted_at IS NOT NULL OR status IN ('submitted', 'late') THEN 1 ELSE 0 END), 0) AS submitted,
      COALESCE(SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END), 0) AS missed,
      COALESCE(SUM(CASE
        WHEN status = 'pending' AND datetime(due_at) < datetime(?) THEN 1 ELSE 0 END), 0) AS overdue
    FROM work_reports
    WHERE subject_kind = ?
      AND subject_id = ?
      AND datetime(due_at) >= datetime(?)
      AND datetime(due_at) < datetime(?)
  `).get(now.toISOString(), subject.kind, subject.id, window.startAt, window.endAt) as {
    due: number;
    submitted: number;
    missed: number;
    overdue: number;
  };
  return row;
}

function organizationTeamCoverage(
  database: Database.Database,
  organizationId: string,
  window: PerformancePeriodWindow,
): { activeTeams: number; teamsWithEvidence: number; percentage: number } {
  const row = database.prepare(`
    SELECT
      COUNT(*) AS active_teams,
      COALESCE(SUM(CASE WHEN EXISTS (
        SELECT 1
        FROM tasks k
        WHERE k.team_id = t.id
          AND k.status = 'completed'
          AND datetime(COALESCE(k.completed_at, k.updated_at, k.created_at)) >= datetime(?)
          AND datetime(COALESCE(k.completed_at, k.updated_at, k.created_at)) < datetime(?)
      ) THEN 1 ELSE 0 END), 0) AS teams_with_evidence
    FROM teams t
    WHERE t.organization_id = ?
      AND t.is_active = 1
  `).get(window.startAt, window.endAt, organizationId) as {
    active_teams: number;
    teams_with_evidence: number;
  };
  return {
    activeTeams: row.active_teams,
    teamsWithEvidence: row.teams_with_evidence,
    percentage: row.active_teams > 0
      ? Math.round((row.teams_with_evidence / row.active_teams) * 10_000) / 100
      : 0,
  };
}

function teamTarget(period: PerformancePeriod, isAlwaysOn: boolean): number {
  if (period === 'daily') return 1;
  if (period === 'weekly') return isAlwaysOn ? 5 : 1;
  return isAlwaysOn ? 20 : 4;
}

function attainment(current: number, target: number, direction: 'increase' | 'decrease'): number {
  if (direction === 'decrease') {
    if (current <= target) return 100;
    return current <= 0 ? 100 : Math.max(0, Math.min(100, (target / current) * 100));
  }
  if (target <= 0) return current > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, (current / target) * 100));
}

function finalizePastGoals(
  database: Database.Database,
  windows: PerformancePeriodWindow[],
): number {
  const statement = database.prepare(`
    UPDATE team_goals
    SET
      status = CASE
        WHEN direction = 'decrease'
          THEN CASE WHEN current_value <= COALESCE(target_value, 0) THEN 'met' ELSE 'missed' END
        ELSE CASE WHEN current_value >= COALESCE(target_value, 1) THEN 'met' ELSE 'missed' END
      END,
      updated_at = datetime('now')
    WHERE source = ?
      AND period = ?
      AND period_key < ?
      AND status = 'active'
  `);
  return windows.reduce(
    (total, window) => total + statement.run(
      PERFORMANCE_GOVERNANCE_SOURCE,
      window.period,
      window.key,
    ).changes,
    0,
  );
}

function coverageCount(
  database: Database.Database,
  table: 'team_goals' | 'performance_reports',
  subjects: PerformanceSubject[],
  windows: PerformancePeriodWindow[],
): number {
  const query = database.prepare(`
    SELECT 1
    FROM ${table}
    WHERE subject_kind = ?
      AND subject_id = ?
      AND period = ?
      AND period_key = ?
      AND source = ?
    LIMIT 1
  `);
  let present = 0;
  for (const subject of subjects) {
    for (const window of windows) {
      if (query.get(
        subject.kind,
        subject.id,
        window.period,
        window.key,
        PERFORMANCE_GOVERNANCE_SOURCE,
      )) present++;
    }
  }
  return present;
}

export function runPerformanceGovernance(options: {
  database?: Database.Database;
  now?: Date;
} = {}): PerformanceGovernanceResult {
  const database = options.database ?? getDb();
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const windows = getKstPerformancePeriods(now);
  const subjects = listActivePerformanceSubjects(database);
  const activeOrganizations = subjects.filter(subject => subject.kind === 'organization').length;
  const activeTeams = subjects.length - activeOrganizations;
  const expected = subjects.length * windows.length;

  const result: PerformanceGovernanceResult = {
    generatedAt,
    periodKeys: Object.fromEntries(
      windows.map(window => [window.period, window.key]),
    ) as Record<PerformancePeriod, string>,
    activeOrganizations,
    activeTeams,
    goalsExpected: expected,
    goalsCreated: 0,
    goalsUpdated: 0,
    goalsFinalized: 0,
    reportsExpected: expected,
    reportsCreated: 0,
    reportsUpdated: 0,
    missingGoalsAfter: expected,
    missingReportsAfter: expected,
  };

  const findGoal = database.prepare(`
    SELECT id
    FROM team_goals
    WHERE subject_kind = ? AND subject_id = ?
      AND period = ? AND period_key = ? AND source = ?
  `);
  const upsertGoal = database.prepare(`
    INSERT INTO team_goals (
      id, subject_kind, subject_id, period, period_key,
      title, metric, target_value, current_value, unit,
      status, note, direction, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 'increase', ?)
    ON CONFLICT(subject_kind, subject_id, period, period_key, source)
      WHERE source = 'performance-governance'
    DO UPDATE SET
      title = excluded.title,
      metric = excluded.metric,
      target_value = excluded.target_value,
      current_value = excluded.current_value,
      unit = excluded.unit,
      status = 'active',
      note = excluded.note,
      updated_at = datetime('now')
  `);
  const findReport = database.prepare(`
    SELECT id
    FROM performance_reports
    WHERE subject_kind = ? AND subject_id = ?
      AND period = ? AND period_key = ? AND source = ?
  `);
  const upsertReport = database.prepare(`
    INSERT INTO performance_reports (
      id, subject_kind, subject_id, period, period_key,
      metrics_json, reflection, improvement, source, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(subject_kind, subject_id, period, period_key, source)
      WHERE source = 'performance-governance'
    DO UPDATE SET
      metrics_json = excluded.metrics_json,
      reflection = excluded.reflection,
      improvement = excluded.improvement,
      updated_at = excluded.updated_at
  `);

  database.transaction(() => {
    result.goalsFinalized = finalizePastGoals(database, windows);

    for (const subject of subjects) {
      for (const window of windows) {
        const tasks = taskStats(database, subject, window);
        const workReports = workReportStats(database, subject, window, now);
        const orgCoverage = subject.kind === 'organization'
          ? organizationTeamCoverage(database, subject.id, window)
          : null;
        const metric = subject.kind === 'team'
          ? 'completed_task_count'
          : 'active_team_execution_coverage_pct';
        const target = subject.kind === 'team'
          ? teamTarget(window.period, subject.isAlwaysOn)
          : 100;
        const current = subject.kind === 'team'
          ? tasks.completed
          : orgCoverage?.percentage ?? 0;
        const unit = subject.kind === 'team' ? '건' : '%';
        const goalAttainmentPct = Math.round(attainment(current, target, 'increase') * 100) / 100;
        const taskSuccessRatePct = tasks.terminalDenominator > 0
          ? Math.round((tasks.completed / tasks.terminalDenominator) * 10_000) / 100
          : 0;
        const workReportSubmissionRatePct = workReports.due > 0
          ? Math.round((workReports.submitted / workReports.due) * 10_000) / 100
          : 0;
        const isOnTrack = goalAttainmentPct >= 100
          && tasks.failed === 0
          && workReports.missed + workReports.overdue === 0;
        const gap = Math.max(0, target - current);
        const nextAction = subject.kind === 'organization' && (orgCoverage?.activeTeams ?? 0) === 0
          ? '활성 실행팀을 배정하고 책임자·일정을 등록한다.'
          : gap > 0
            ? `${window.period} 목표까지 ${gap}${unit}의 검증 가능한 실행 증거를 추가한다.`
            : tasks.failed > 0
              ? `최근 실패 ${tasks.failed}건의 원인을 복구하고 재발 방지 근거를 남긴다.`
              : workReports.missed + workReports.overdue > 0
                ? `누락·지연 업무보고 ${workReports.missed + workReports.overdue}건을 해소한다.`
                : '현재 흐름을 유지하고 다음 점검 때 동일한 근거를 재검증한다.';
        const note = [
          `자동 운영 목표(${window.period} ${window.key}).`,
          `근거 창: ${window.startAt} 이상 ${window.endAt} 미만.`,
          `현재 격차: ${gap}${unit}. 다음 행동: ${nextAction}`,
        ].join(' ');
        const goalExists = Boolean(findGoal.get(
          subject.kind,
          subject.id,
          window.period,
          window.key,
          PERFORMANCE_GOVERNANCE_SOURCE,
        ));
        const goalId = createId('goal');
        upsertGoal.run(
          goalId,
          subject.kind,
          subject.id,
          window.period,
          window.key,
          `${subject.name} ${window.period} 검증 성과 목표`,
          metric,
          target,
          current,
          unit,
          note,
          PERFORMANCE_GOVERNANCE_SOURCE,
        );
        if (goalExists) result.goalsUpdated++;
        else result.goalsCreated++;

        const metrics = {
          schemaVersion: 1,
          subject: { kind: subject.kind, id: subject.id, name: subject.name },
          period: {
            type: window.period,
            key: window.key,
            timezone: 'Asia/Seoul',
            startAt: window.startAt,
            endAt: window.endAt,
            generatedAt,
          },
          goal: {
            id: goalExists
              ? (findGoal.get(
                subject.kind,
                subject.id,
                window.period,
                window.key,
                PERFORMANCE_GOVERNANCE_SOURCE,
              ) as { id: string }).id
              : goalId,
            metric,
            target,
            current,
            unit,
            direction: 'increase',
            attainmentPct: goalAttainmentPct,
            status: isOnTrack ? 'on_track' : 'attention',
          },
          execution: {
            taskTotal: tasks.total,
            taskCompleted: tasks.completed,
            taskFailed: tasks.failed,
            taskInProgress: tasks.inProgress,
            terminalDenominator: tasks.terminalDenominator,
            successRatePct: taskSuccessRatePct,
            denominatorDefinition: 'completed + failed + timed_out + lease_expired',
            exclusions: ['cancelled', 'team_id가 없는 태스크'],
          },
          workReports: {
            due: workReports.due,
            submitted: workReports.submitted,
            missed: workReports.missed,
            overdue: workReports.overdue,
            submissionRatePct: workReportSubmissionRatePct,
            denominatorDefinition: '기간 내 due_at이며 waived가 아닌 업무보고',
          },
          organizationTeamCoverage: orgCoverage,
          guidance: {
            status: isOnTrack ? 'on_track' : 'attention',
            gap,
            nextAction,
          },
          source: {
            tables: ['organizations', 'teams', 'tasks', 'team_goals', 'work_reports'],
            cadence: 'hourly + daily/weekly/monthly rollup',
            freshnessAt: generatedAt,
          },
        };
        const reportExists = Boolean(findReport.get(
          subject.kind,
          subject.id,
          window.period,
          window.key,
          PERFORMANCE_GOVERNANCE_SOURCE,
        ));
        upsertReport.run(
          createId('perf'),
          subject.kind,
          subject.id,
          window.period,
          window.key,
          JSON.stringify(metrics),
          `${subject.name}: 목표 달성률 ${goalAttainmentPct}%, 태스크 성공률 ${taskSuccessRatePct}%를 실제 저장 데이터로 점검했다.`,
          nextAction,
          PERFORMANCE_GOVERNANCE_SOURCE,
          generatedAt,
        );
        if (reportExists) result.reportsUpdated++;
        else result.reportsCreated++;
      }
    }

    result.missingGoalsAfter = expected - coverageCount(database, 'team_goals', subjects, windows);
    result.missingReportsAfter = expected - coverageCount(
      database,
      'performance_reports',
      subjects,
      windows,
    );
  })();

  log.info(result, 'Performance governance cycle completed');
  return result;
}

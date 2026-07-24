import type Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { resolveInternalProjectDir } from '../utils/project-dir.js';
import { formatKstDate } from './work-report-scheduler.js';

export const HR_HOURLY_ROLE_AUDIT_JOB_ID = 'hr-hourly-role-audit';
export const HR_HOURLY_ROLE_AUDIT_SCHEDULE = '35 * * * *';
const SELF_IMPROVEMENT_MAX_AGE_MS = 90 * 60 * 1000;

export interface DailyGoalCoverageResult {
  periodKey: string;
  activeOrganizations: number;
  activeTeams: number;
  finalizedPreviousGoals: number;
  createdOrganizationGoals: number;
  createdTeamGoals: number;
  updatedManagedGoals: number;
  missingAfter: number;
}

export interface SelfImprovementEvidence {
  checklistDate: string | null;
  checkedAt: string | null;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  deferred: number;
  dispatched: boolean;
  dispatchSkippedReason: string | null;
  readable: boolean;
}

export interface HourlyRoleAuditResult {
  checkedAt: string;
  goalCoverage: DailyGoalCoverageResult;
  hr: {
    status: 'pass' | 'attention' | 'fail';
    checks: Record<string, boolean>;
  };
  selfImprovement: {
    status: 'pass' | 'attention' | 'fail';
    checks: Record<string, boolean>;
    evidence: SelfImprovementEvidence;
  };
}

export interface HourlyRoleAuditOptions {
  database?: Database.Database;
  now?: Date;
  source?: 'scheduled' | 'startup' | 'manual';
  selfImprovementEvidence?: SelfImprovementEvidence;
}

interface ActiveSubjectRow {
  id: string;
  name: string;
  charter: string | null;
}

function kstDayBounds(now: Date): { start: string; end: string } {
  const periodKey = formatKstDate(now);
  const [year, month, day] = periodKey.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day, -9, 0, 0, 0));
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

function finalizePreviousDailyGoals(
  database: Database.Database,
  periodKey: string,
): number {
  return database.prepare(`
    UPDATE team_goals
    SET
      status = CASE
        WHEN direction = 'decrease'
          THEN CASE WHEN target_value IS NULL
            THEN CASE WHEN current_value <= 0 THEN 'met' ELSE 'missed' END
            ELSE CASE WHEN current_value <= target_value THEN 'met' ELSE 'missed' END
          END
        ELSE CASE WHEN target_value IS NULL
          THEN CASE WHEN current_value > 0 THEN 'met' ELSE 'missed' END
          ELSE CASE WHEN current_value >= target_value THEN 'met' ELSE 'missed' END
        END
      END,
      updated_at = datetime('now')
    WHERE period = 'daily'
      AND period_key < ?
      AND status = 'active'
  `).run(periodKey).changes;
}

function activeSubjects(
  database: Database.Database,
  kind: 'organization' | 'team',
): ActiveSubjectRow[] {
  if (kind === 'organization') {
    return database.prepare(`
      SELECT id, name, NULL AS charter
      FROM organizations
      WHERE is_active = 1
      ORDER BY id
    `).all() as ActiveSubjectRow[];
  }
  return database.prepare(`
    SELECT id, name, charter
    FROM teams
    WHERE is_active = 1
    ORDER BY id
  `).all() as ActiveSubjectRow[];
}

function insertMissingDailyGoals(
  database: Database.Database,
  kind: 'organization' | 'team',
  periodKey: string,
): number {
  const hasToday = database.prepare(`
    SELECT 1
    FROM team_goals
    WHERE subject_kind = ?
      AND subject_id = ?
      AND period = 'daily'
      AND period_key = ?
    LIMIT 1
  `);
  const insert = database.prepare(`
    INSERT OR IGNORE INTO team_goals (
      id, subject_kind, subject_id, period, period_key,
      title, metric, target_value, current_value, unit,
      status, note, direction, source
    ) VALUES (
      ?, ?, ?, 'daily', ?, ?, ?, ?, 0, ?,
      'active', ?, 'increase', 'hr-daily-coverage'
    )
  `);

  let created = 0;
  for (const subject of activeSubjects(database, kind)) {
    if (hasToday.get(kind, subject.id, periodKey)) continue;
    const isTeam = kind === 'team';
    const result = insert.run(
      createId('goal'),
      kind,
      subject.id,
      periodKey,
      isTeam
        ? `${subject.name} 일일 역할 수행 증거 확보`
        : `${subject.name} 소속 팀 일일 역할 수행 증거 확보`,
      isTeam ? 'completed_task_count' : 'active_team_evidence_ratio',
      isTeam ? 1 : 100,
      isTeam ? '건' : '%',
      isTeam
        ? `HR 자동 커버리지 목표. 역할 헌장: ${(subject.charter ?? '역할 헌장 미등록').slice(0, 360)}`
        : 'HR 자동 커버리지 목표. 활성 소속 팀 중 오늘 완료 태스크가 있는 팀 비율을 매시간 갱신한다.',
    );
    created += result.changes;
  }
  return created;
}

function updateManagedGoalProgress(
  database: Database.Database,
  periodKey: string,
  now: Date,
): number {
  const bounds = kstDayBounds(now);
  const managed = database.prepare(`
    SELECT id, subject_kind, subject_id
    FROM team_goals
    WHERE period = 'daily'
      AND period_key = ?
      AND source = 'hr-daily-coverage'
      AND status = 'active'
  `).all(periodKey) as Array<{
    id: string;
    subject_kind: 'organization' | 'team';
    subject_id: string;
  }>;
  const completedTeamTasks = database.prepare(`
    SELECT COUNT(*) AS count
    FROM tasks
    WHERE team_id = ?
      AND status = 'completed'
      AND datetime(created_at) >= datetime(?)
      AND datetime(created_at) < datetime(?)
  `);
  const organizationEvidence = database.prepare(`
    SELECT
      COUNT(*) AS team_count,
      COALESCE(SUM(CASE WHEN EXISTS (
        SELECT 1
        FROM tasks k
        WHERE k.team_id = t.id
          AND k.status = 'completed'
          AND datetime(k.created_at) >= datetime(?)
          AND datetime(k.created_at) < datetime(?)
      ) THEN 1 ELSE 0 END), 0) AS teams_with_evidence
    FROM teams t
    WHERE t.organization_id = ?
      AND t.is_active = 1
  `);
  const update = database.prepare(`
    UPDATE team_goals
    SET current_value = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  for (const goal of managed) {
    let value: number;
    if (goal.subject_kind === 'team') {
      value = (completedTeamTasks.get(
        goal.subject_id,
        bounds.start,
        bounds.end,
      ) as { count: number }).count;
    } else {
      const evidence = organizationEvidence.get(
        bounds.start,
        bounds.end,
        goal.subject_id,
      ) as { team_count: number; teams_with_evidence: number };
      value = evidence.team_count > 0
        ? Math.round((evidence.teams_with_evidence / evidence.team_count) * 100)
        : 0;
    }
    update.run(value, goal.id);
  }
  return managed.length;
}

export function ensureDailyGoalCoverage(
  database: Database.Database = getDb(),
  now: Date = new Date(),
): DailyGoalCoverageResult {
  const periodKey = formatKstDate(now);
  const apply = database.transaction(() => {
    const finalizedPreviousGoals = finalizePreviousDailyGoals(database, periodKey);
    const createdOrganizationGoals = insertMissingDailyGoals(database, 'organization', periodKey);
    const createdTeamGoals = insertMissingDailyGoals(database, 'team', periodKey);
    const updatedManagedGoals = updateManagedGoalProgress(database, periodKey, now);
    const missingAfter = (database.prepare(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT 'organization' AS subject_kind, id AS subject_id
        FROM organizations
        WHERE is_active = 1
        UNION ALL
        SELECT 'team' AS subject_kind, id AS subject_id
        FROM teams
        WHERE is_active = 1
      ) active_subjects
      WHERE NOT EXISTS (
        SELECT 1
        FROM team_goals g
        WHERE g.subject_kind = active_subjects.subject_kind
          AND g.subject_id = active_subjects.subject_id
          AND g.period = 'daily'
          AND g.period_key = ?
      )
    `).get(periodKey) as { count: number }).count;
    return {
      periodKey,
      activeOrganizations: activeSubjects(database, 'organization').length,
      activeTeams: activeSubjects(database, 'team').length,
      finalizedPreviousGoals,
      createdOrganizationGoals,
      createdTeamGoals,
      updatedManagedGoals,
      missingAfter,
    };
  });
  return apply();
}

function safeJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function readSelfImprovementEvidence(
  root = resolveInternalProjectDir(),
): SelfImprovementEvidence {
  const directory = resolve(root, 'data/self-improve');
  const checklist = safeJson(resolve(directory, 'checklist-latest.json'));
  const status = safeJson(resolve(directory, 'status-latest.json'));
  const dispatch = status?.dispatch && typeof status.dispatch === 'object'
    ? status.dispatch as Record<string, unknown>
    : null;
  return {
    checklistDate: typeof checklist?.date === 'string' ? checklist.date : null,
    checkedAt: typeof status?.checked_at === 'string' ? status.checked_at : null,
    total: numberValue(status?.total),
    passed: numberValue(status?.pass),
    failed: numberValue(status?.fail),
    skipped: numberValue(status?.skip),
    deferred: numberValue(status?.defer),
    dispatched: Boolean(dispatch?.dispatched),
    dispatchSkippedReason: typeof dispatch?.skipped_reason === 'string'
      ? dispatch.skipped_reason
      : null,
    readable: Boolean(checklist && status),
  };
}

function sqliteUtcAgeMs(value: string | null, now: Date): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? now.getTime() - parsed : Number.POSITIVE_INFINITY;
}

function recordAudit(
  database: Database.Database,
  kind: 'hr' | 'self-improvement',
  subjectId: string,
  status: 'pass' | 'attention' | 'fail',
  checks: Record<string, boolean>,
  evidence: Record<string, unknown>,
  source: 'scheduled' | 'startup' | 'manual',
): void {
  database.prepare(`
    INSERT INTO hourly_role_audits (
      id, subject_kind, subject_id, status, checks_json, evidence_json, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    createId('hra'),
    kind,
    subjectId,
    status,
    JSON.stringify(checks),
    JSON.stringify(evidence),
    source,
  );
}

export function runHourlyRoleAudit(
  options: HourlyRoleAuditOptions = {},
): HourlyRoleAuditResult {
  const database = options.database ?? getDb();
  const now = options.now ?? new Date();
  const source = options.source ?? 'scheduled';
  const goalCoverage = ensureDailyGoalCoverage(database, now);

  const hrTeam = database.prepare(`
    SELECT is_active, is_always_on, lead
    FROM teams
    WHERE id = 'team_hr-director'
  `).get() as { is_active: number; is_always_on: number; lead: string | null } | undefined;
  const lifecycleJob = database.prepare(`
    SELECT schedule, enabled, last_run_at, last_status
    FROM cron_jobs
    WHERE id = 'team-score-diagnostics'
  `).get() as {
    schedule: string;
    enabled: number;
    last_run_at: string | null;
    last_status: string | null;
  } | undefined;
  const weeklyJob = database.prepare(`
    SELECT enabled
    FROM cron_jobs
    WHERE id = 'hr-weekly-workforce-planning'
  `).get() as { enabled: number } | undefined;
  const lifecycleAgeMs = sqliteUtcAgeMs(lifecycleJob?.last_run_at ?? null, now);
  const hrChecks = {
    teamActive: hrTeam?.is_active === 1,
    teamAlwaysOn: hrTeam?.is_always_on === 1,
    roleOwnerPresent: Boolean(hrTeam?.lead?.trim()),
    lifecycleEveryTenMinutes: lifecycleJob?.enabled === 1
      && lifecycleJob.schedule === '*/10 * * * *',
    lifecycleRecentlySuccessful: lifecycleJob?.last_status === 'success'
      && lifecycleAgeMs >= 0
      && lifecycleAgeMs <= 30 * 60 * 1000,
    weeklyPlanningEnabled: weeklyJob?.enabled === 1,
    allActiveSubjectsHaveTodayGoal: goalCoverage.missingAfter === 0,
  };
  const hrStatus = Object.values(hrChecks).every(Boolean)
    ? 'pass'
    : hrChecks.teamActive && hrChecks.lifecycleEveryTenMinutes
      ? 'attention'
      : 'fail';

  const selfEvidence = options.selfImprovementEvidence ?? readSelfImprovementEvidence();
  const selfTeam = database.prepare(`
    SELECT t.is_active AS team_active, o.is_active AS organization_active, o.schedule
    FROM teams t
    JOIN organizations o ON o.id = t.organization_id
    WHERE t.id = 'team_self-improvement'
      AND o.id = 'org_nco-self'
  `).get() as {
    team_active: number;
    organization_active: number;
    schedule: string | null;
  } | undefined;
  const parsedCheckedAt = selfEvidence.checkedAt ? Date.parse(selfEvidence.checkedAt) : Number.NaN;
  const evidenceAge = Number.isFinite(parsedCheckedAt)
    ? now.getTime() - parsedCheckedAt
    : Number.POSITIVE_INFINITY;
  const improvementHandling = selfEvidence.failed === 0
    || selfEvidence.dispatched
    || Boolean(selfEvidence.dispatchSkippedReason);
  const selfChecks = {
    companyActive: selfTeam?.organization_active === 1,
    teamActive: selfTeam?.team_active === 1,
    actualHourlyScheduleRegistered: selfTeam?.schedule === '20 * * * *',
    checklistGeneratedToday: selfEvidence.checklistDate === formatKstDate(now),
    hourlyResultReadable: selfEvidence.readable && selfEvidence.total > 0,
    checkedWithinNinetyMinutes: evidenceAge >= 0
      && evidenceAge <= SELF_IMPROVEMENT_MAX_AGE_MS,
    failuresReviewedOrDispatched: improvementHandling,
  };
  const selfStatus = Object.values(selfChecks).every(Boolean)
    ? 'pass'
    : selfChecks.companyActive && selfChecks.teamActive
      ? 'attention'
      : 'fail';

  const persist = database.transaction(() => {
    recordAudit(database, 'hr', 'team_hr-director', hrStatus, hrChecks, {
      goalCoverage,
      lifecycleLastRunAt: lifecycleJob?.last_run_at ?? null,
      lifecycleLastStatus: lifecycleJob?.last_status ?? null,
    }, source);
    recordAudit(
      database,
      'self-improvement',
      'org_nco-self',
      selfStatus,
      selfChecks,
      { ...selfEvidence, evidenceAgeMs: Number.isFinite(evidenceAge) ? evidenceAge : null },
      source,
    );
  });
  persist();

  return {
    checkedAt: now.toISOString(),
    goalCoverage,
    hr: { status: hrStatus, checks: hrChecks },
    selfImprovement: {
      status: selfStatus,
      checks: selfChecks,
      evidence: selfEvidence,
    },
  };
}

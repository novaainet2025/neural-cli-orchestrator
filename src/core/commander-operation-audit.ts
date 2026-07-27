import type Database from 'better-sqlite3';
import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';
import {
  getKstPerformancePeriods,
  listActivePerformanceSubjects,
  PERFORMANCE_GOVERNANCE_SOURCE,
} from './performance-governance.js';

const log = createLogger('commander-operation-audit');

export const PERFORMANCE_CRON_REQUIREMENTS = [
  { id: 'pg-hourly-progress-refresh', schedule: '0 * * * *', maxAgeMs: 2 * 60 * 60 * 1000 },
  { id: 'pg-daily-rollup', schedule: '10 0 * * *', maxAgeMs: 36 * 60 * 60 * 1000 },
  { id: 'pg-weekly-rollup', schedule: '15 0 * * 1', maxAgeMs: 8 * 24 * 60 * 60 * 1000 },
  { id: 'pg-monthly-rollup', schedule: '20 0 1 * *', maxAgeMs: 33 * 24 * 60 * 60 * 1000 },
  { id: 'pg-hourly-commander-audit', schedule: '5 * * * *', maxAgeMs: 2 * 60 * 60 * 1000 },
  { id: 'org-design-hourly-audit', schedule: '15 * * * *', maxAgeMs: 3 * 60 * 60 * 1000 },
] as const;

type AuditStatus = 'pass' | 'attention' | 'fail';
type AuditSource = 'scheduled' | 'startup' | 'manual';

interface CronAuditRow {
  id: string;
  schedule: string;
  timezone: string;
  task_type: string;
  enabled: number;
  last_run_at: string | null;
  last_status: string | null;
  created_at: string;
}

export interface CommanderOperationAuditResult {
  id: string;
  auditTime: string;
  source: AuditSource;
  status: AuditStatus;
  activeOrganizations: number;
  activeTeams: number;
  goalsExpected: number;
  goalsPresent: number;
  reportsExpected: number;
  reportsPresent: number;
  failedTasks: number;
  stalledTasks: number;
  missedWorkReports: number;
  schedulesExpected: number;
  schedulesHealthy: number;
  checks: Record<string, unknown>;
  evidence: string[];
}

function sqliteUtcMillis(value: string | null): number | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const millis = new Date(normalized).getTime();
  return Number.isFinite(millis) ? millis : null;
}

export function runCommanderOperationAudit(options: {
  database?: Database.Database;
  now?: Date;
  source?: AuditSource;
} = {}): CommanderOperationAuditResult {
  const database = options.database ?? getDb();
  const now = options.now ?? new Date();
  const source = options.source ?? 'scheduled';
  const windows = getKstPerformancePeriods(now);
  const subjects = listActivePerformanceSubjects(database);
  const activeOrganizations = subjects.filter(subject => subject.kind === 'organization').length;
  const activeTeams = subjects.length - activeOrganizations;
  const expected = subjects.length * windows.length;

  const hasGoal = database.prepare(`
    SELECT 1 FROM team_goals
    WHERE subject_kind = ? AND subject_id = ?
      AND period = ? AND period_key = ? AND source = ?
    LIMIT 1
  `);
  const hasReport = database.prepare(`
    SELECT 1 FROM performance_reports
    WHERE subject_kind = ? AND subject_id = ?
      AND period = ? AND period_key = ? AND source = ?
    LIMIT 1
  `);
  let goalsPresent = 0;
  let reportsPresent = 0;
  for (const subject of subjects) {
    for (const window of windows) {
      const params = [
        subject.kind,
        subject.id,
        window.period,
        window.key,
        PERFORMANCE_GOVERNANCE_SOURCE,
      ] as const;
      if (hasGoal.get(...params)) goalsPresent++;
      if (hasReport.get(...params)) reportsPresent++;
    }
  }

  const recentStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const stalledBefore = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const failedTasks = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM tasks k
    JOIN teams t ON t.id = k.team_id
    LEFT JOIN organizations o ON o.id = t.organization_id
    WHERE t.is_active = 1
      AND (t.organization_id IS NULL OR o.is_active = 1)
      AND k.status IN ('failed', 'timed_out', 'lease_expired')
      AND datetime(COALESCE(k.completed_at, k.updated_at, k.created_at)) >= datetime(?)
  `).get(recentStart) as { count: number }).count;
  const stalledTasks = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM tasks k
    JOIN teams t ON t.id = k.team_id
    LEFT JOIN organizations o ON o.id = t.organization_id
    WHERE t.is_active = 1
      AND (t.organization_id IS NULL OR o.is_active = 1)
      AND k.status IN ('assigned', 'running', 'streaming', 'reviewing')
      AND datetime(COALESCE(k.last_activity_at, k.updated_at, k.created_at)) <= datetime(?)
  `).get(stalledBefore) as { count: number }).count;
  const day = windows.find(window => window.period === 'daily');
  if (!day) throw new Error('Daily performance period is missing');
  const missedWorkReports = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM work_reports w
    WHERE datetime(w.due_at) >= datetime(?)
      AND datetime(w.due_at) < datetime(?)
      AND (
        w.status = 'missed'
        OR (w.status = 'pending' AND datetime(w.due_at) < datetime(?))
      )
  `).get(day.startAt, day.endAt, now.toISOString()) as { count: number }).count;

  const cronById = new Map(
    (database.prepare(`
      SELECT id, schedule, timezone, task_type, enabled,
             last_run_at, last_status, created_at
      FROM cron_jobs
      WHERE id IN (${PERFORMANCE_CRON_REQUIREMENTS.map(() => '?').join(',')})
    `).all(...PERFORMANCE_CRON_REQUIREMENTS.map(job => job.id)) as CronAuditRow[])
      .map(row => [row.id, row]),
  );
  const scheduleChecks = PERFORMANCE_CRON_REQUIREMENTS.map(requirement => {
    const row = cronById.get(requirement.id);
    if (!row) {
      return {
        id: requirement.id,
        configured: false,
        timing: 'missing',
        healthy: false,
      };
    }
    const configured = row.enabled === 1
      && row.schedule === requirement.schedule
      && row.timezone === 'Asia/Seoul'
      && row.task_type === 'internal';
    const lastRunMillis = sqliteUtcMillis(row.last_run_at);
    const createdMillis = sqliteUtcMillis(row.created_at) ?? now.getTime();
    const referenceMillis = lastRunMillis ?? createdMillis;
    const overdue = now.getTime() - referenceMillis > requirement.maxAgeMs;
    const lastFailed = row.last_status === 'failed';
    return {
      id: requirement.id,
      configured,
      schedule: row.schedule,
      timezone: row.timezone,
      enabled: row.enabled === 1,
      lastRunAt: row.last_run_at,
      lastStatus: row.last_status,
      timing: lastRunMillis ? (overdue ? 'stale' : 'fresh') : (overdue ? 'never_ran_overdue' : 'not_due_yet'),
      healthy: configured && !overdue && !lastFailed,
    };
  });
  const schedulesHealthy = scheduleChecks.filter(check => check.healthy).length;

  const missingManagers = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM organizations
    WHERE is_active = 1 AND (manager IS NULL OR TRIM(manager) = '')
  `).get() as { count: number }).count;
  const missingTeamLeads = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM teams t
    LEFT JOIN organizations o ON o.id = t.organization_id
    WHERE t.is_active = 1
      AND (t.organization_id IS NULL OR o.is_active = 1)
      AND (t.lead IS NULL OR TRIM(t.lead) = '')
  `).get() as { count: number }).count;
  const missingTeamCharters = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM teams t
    LEFT JOIN organizations o ON o.id = t.organization_id
    WHERE t.is_active = 1
      AND (t.organization_id IS NULL OR o.is_active = 1)
      AND (t.charter IS NULL OR TRIM(t.charter) = '')
  `).get() as { count: number }).count;
  const organizationsWithoutTeams = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM organizations o
    WHERE o.is_active = 1
      AND NOT EXISTS (
        SELECT 1 FROM teams t
        WHERE t.organization_id = o.id AND t.is_active = 1
      )
  `).get() as { count: number }).count;

  const evidence: string[] = [];
  let status: AuditStatus = 'pass';
  if (goalsPresent !== expected) {
    status = 'fail';
    evidence.push(`자동 목표 누락: ${expected - goalsPresent}건 (${goalsPresent}/${expected})`);
  }
  if (reportsPresent !== expected) {
    status = 'fail';
    evidence.push(`자동 성과보고 누락: ${expected - reportsPresent}건 (${reportsPresent}/${expected})`);
  }
  if (schedulesHealthy !== PERFORMANCE_CRON_REQUIREMENTS.length) {
    status = 'fail';
    evidence.push(`자동화 예약 이상: ${PERFORMANCE_CRON_REQUIREMENTS.length - schedulesHealthy}건`);
  }
  if (stalledTasks > 0) {
    status = 'fail';
    evidence.push(`2시간 이상 정체된 활성 태스크: ${stalledTasks}건`);
  }
  if (failedTasks > 0) {
    if (status === 'pass') status = 'attention';
    evidence.push(`최근 24시간 실패·시간초과 태스크: ${failedTasks}건`);
  }
  if (missedWorkReports > 0) {
    if (status === 'pass') status = 'attention';
    evidence.push(`오늘 누락·기한초과 업무보고: ${missedWorkReports}건`);
  }
  const structuralGaps = missingManagers + missingTeamLeads + missingTeamCharters + organizationsWithoutTeams;
  if (structuralGaps > 0) {
    if (status === 'pass') status = 'attention';
    evidence.push(
      `구조 보완 필요: 관리자 ${missingManagers}, 팀장 ${missingTeamLeads}, 헌장 ${missingTeamCharters}, 실행팀 없는 회사 ${organizationsWithoutTeams}`,
    );
  }

  // Org design audit freshness check (graceful on older/unit-test DBs without the table)
  const hasOrgDesignTable = !!database.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'organization_design_audits'
    LIMIT 1
  `).get();

  let orgDesignHealth: Record<string, unknown> = { checked: false, available: false };
  if (hasOrgDesignTable) {
    const lastOrgDesign = database.prepare(`
      SELECT audit_time, status,
             org_expected, org_present, cap_expected, cap_present,
             active_teams, members_after_coverage,
             collaboration_coverage_after,
             missing_lead_after, missing_charter_after
      FROM organization_design_audits
      ORDER BY audit_time DESC LIMIT 1
    `).get() as {
      audit_time: string; status: string;
      org_expected: number; org_present: number;
      cap_expected: number; cap_present: number;
      active_teams: number; members_after_coverage: number;
      collaboration_coverage_after: number;
      missing_lead_after: number; missing_charter_after: number;
    } | undefined;

    if (lastOrgDesign) {
      const lastRunMs = new Date(lastOrgDesign.audit_time).getTime();
      const staleMs = now.getTime() - lastRunMs;
      const fresh = staleMs < 3 * 60 * 60 * 1000;
      const orgFullCoverage = lastOrgDesign.org_present >= lastOrgDesign.org_expected;
      const capFullCoverage = lastOrgDesign.cap_present >= lastOrgDesign.cap_expected;
      const collabFullCoverage = lastOrgDesign.collaboration_coverage_after >= 1.0;
      const hasMissingAfter = lastOrgDesign.missing_lead_after > 0 || lastOrgDesign.missing_charter_after > 0;
      const isFailStatus = lastOrgDesign.status === 'fail';
      orgDesignHealth = {
        checked: true,
        available: true,
        fresh,
        staleHours: Math.round(staleMs / 3600000 * 10) / 10,
        status: lastOrgDesign.status,
        orgCoverage: `${lastOrgDesign.org_present}/${lastOrgDesign.org_expected}`,
        capCoverage: `${lastOrgDesign.cap_present}/${lastOrgDesign.cap_expected}`,
        collaborationCoverage: lastOrgDesign.collaboration_coverage_after,
        memberCoverage: lastOrgDesign.members_after_coverage,
        activeTeams: lastOrgDesign.active_teams,
        missingLeadAfter: lastOrgDesign.missing_lead_after,
        missingCharterAfter: lastOrgDesign.missing_charter_after,
      };
      if (isFailStatus || !orgFullCoverage || !capFullCoverage || !collabFullCoverage || hasMissingAfter) {
        status = 'fail';
        const reasons: string[] = [];
        if (isFailStatus) reasons.push(`감사상태=${lastOrgDesign.status}`);
        if (!orgFullCoverage) reasons.push(`회사커버리지=${lastOrgDesign.org_present}/${lastOrgDesign.org_expected}`);
        if (!capFullCoverage) reasons.push(`역량커버리지=${lastOrgDesign.cap_present}/${lastOrgDesign.cap_expected}`);
        if (!collabFullCoverage) reasons.push(`협업커버리지=${lastOrgDesign.collaboration_coverage_after}`);
        if (lastOrgDesign.missing_lead_after > 0) reasons.push(`리더미지정=${lastOrgDesign.missing_lead_after}`);
        if (lastOrgDesign.missing_charter_after > 0) reasons.push(`헌장미정의=${lastOrgDesign.missing_charter_after}`);
        evidence.push(`조직설계 감사 실패: ${reasons.join(', ')}`);
      } else if (!fresh || lastOrgDesign.status === 'attention') {
        if (status === 'pass') status = 'attention';
        if (!fresh) evidence.push(`조직설계 감사 정보부실: 마지막 실행 ${Math.round(staleMs / 3600000 * 10) / 10}시간 전`);
        if (lastOrgDesign.status === 'attention') evidence.push(`조직설계 감사 주의: ${lastOrgDesign.status}`);
      }
    } else {
      orgDesignHealth = { checked: false, available: true };
      if (status === 'pass') status = 'attention';
      evidence.push('조직설계 감사 미실시');
    }
  }

  if (evidence.length === 0) {
    evidence.push('모든 활성 회사·팀의 목표, 성과보고, 실행 상태와 자동화 예약이 정상이다.');
  }

  const checks = {
    coverage: {
      goals: { expected, present: goalsPresent, complete: goalsPresent === expected },
      reports: { expected, present: reportsPresent, complete: reportsPresent === expected },
    },
    execution: {
      failedTasks24h: failedTasks,
      stalledTasks2h: stalledTasks,
    },
    workReports: {
      missedOrOverdueToday: missedWorkReports,
    },
    automation: scheduleChecks,
    structure: {
      missingManagers,
      missingTeamLeads,
      missingTeamCharters,
      organizationsWithoutTeams,
    },
    orgDesign: orgDesignHealth,
    policy: {
      finalSovereign: 'human-user',
      operationalCommander: 'org_nova-ax / Commander·두뇌',
      auditIsNonDestructive: true,
    },
  };
  const result: CommanderOperationAuditResult = {
    id: createId('cmd-audit'),
    auditTime: now.toISOString(),
    source,
    status,
    activeOrganizations,
    activeTeams,
    goalsExpected: expected,
    goalsPresent,
    reportsExpected: expected,
    reportsPresent,
    failedTasks,
    stalledTasks,
    missedWorkReports,
    schedulesExpected: PERFORMANCE_CRON_REQUIREMENTS.length,
    schedulesHealthy,
    checks,
    evidence,
  };

  database.prepare(`
    INSERT INTO commander_operation_audits (
      id, audit_time, source, status,
      active_organizations, active_teams,
      goals_expected, goals_present, reports_expected, reports_present,
      failed_tasks, stalled_tasks, missed_work_reports,
      schedules_expected, schedules_healthy, checks_json, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.id,
    result.auditTime,
    result.source,
    result.status,
    result.activeOrganizations,
    result.activeTeams,
    result.goalsExpected,
    result.goalsPresent,
    result.reportsExpected,
    result.reportsPresent,
    result.failedTasks,
    result.stalledTasks,
    result.missedWorkReports,
    result.schedulesExpected,
    result.schedulesHealthy,
    JSON.stringify(result.checks),
    JSON.stringify(result.evidence),
  );

  log.info(result, 'Supreme commander operation audit completed');
  return result;
}

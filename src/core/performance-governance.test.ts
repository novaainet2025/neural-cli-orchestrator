import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getKstPerformancePeriods,
  runPerformanceGovernance,
} from './performance-governance.js';
import {
  PERFORMANCE_CRON_REQUIREMENTS,
  runCommanderOperationAudit,
} from './commander-operation-audit.js';

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_always_on INTEGER NOT NULL DEFAULT 1,
      manager TEXT
    );
    CREATE TABLE teams (
      id TEXT PRIMARY KEY, organization_id TEXT,
      name TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1,
      is_always_on INTEGER NOT NULL DEFAULT 1,
      lead TEXT, charter TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, team_id TEXT, status TEXT,
      created_at TEXT, updated_at TEXT, completed_at TEXT,
      last_activity_at TEXT
    );
    CREATE TABLE work_reports (
      id TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT,
      due_at TEXT, status TEXT, submitted_at TEXT
    );
    CREATE TABLE team_goals (
      id TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT,
      period TEXT, period_key TEXT, title TEXT, metric TEXT,
      target_value REAL, current_value REAL DEFAULT 0, unit TEXT,
      status TEXT DEFAULT 'active', note TEXT,
      direction TEXT DEFAULT 'increase', source TEXT DEFAULT 'manual',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_test_governance_goal
      ON team_goals(subject_kind, subject_id, period, period_key, source)
      WHERE source = 'performance-governance';
    CREATE TABLE performance_reports (
      id TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT,
      period TEXT, period_key TEXT, metrics_json TEXT,
      reflection TEXT, improvement TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      source TEXT DEFAULT 'manual', updated_at TEXT
    );
    CREATE UNIQUE INDEX idx_test_governance_report
      ON performance_reports(subject_kind, subject_id, period, period_key, source)
      WHERE source = 'performance-governance';
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY, schedule TEXT, timezone TEXT,
      task_type TEXT, enabled INTEGER, last_run_at TEXT,
      last_status TEXT, created_at TEXT
    );
    CREATE TABLE commander_operation_audits (
      id TEXT PRIMARY KEY, audit_time TEXT, source TEXT, status TEXT,
      active_organizations INTEGER, active_teams INTEGER,
      goals_expected INTEGER, goals_present INTEGER,
      reports_expected INTEGER, reports_present INTEGER,
      failed_tasks INTEGER, stalled_tasks INTEGER,
      missed_work_reports INTEGER, schedules_expected INTEGER,
      schedules_healthy INTEGER, checks_json TEXT, evidence_json TEXT
    );
  `);
}

describe('performance governance operating system', () => {
  let db: Database.Database;
  const now = new Date('2026-07-26T03:00:00.000Z');

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    db.exec(`
      INSERT INTO organizations (id, name, manager)
      VALUES ('org-1', '회사 1', 'commander');
      INSERT INTO teams (id, organization_id, name, lead, charter)
      VALUES ('team-1', 'org-1', '팀 1', 'lead', '검증 가능한 결과를 낸다');
      INSERT INTO tasks (
        id, team_id, status, created_at, updated_at, completed_at, last_activity_at
      ) VALUES
        ('done', 'team-1', 'completed',
         '2026-07-26T00:30:00.000Z', '2026-07-26T01:00:00.000Z',
         '2026-07-26T01:00:00.000Z', '2026-07-26T01:00:00.000Z'),
        ('failed', 'team-1', 'failed',
         '2026-07-26T01:30:00.000Z', '2026-07-26T02:00:00.000Z',
         NULL, '2026-07-26T02:00:00.000Z');
      INSERT INTO work_reports (
        id, subject_kind, subject_id, due_at, status, submitted_at
      ) VALUES (
        'wr-1', 'team', 'team-1',
        '2026-07-26T02:00:00.000Z', 'submitted', '2026-07-26T01:50:00.000Z'
      );
      INSERT INTO team_goals (
        id, subject_kind, subject_id, period, period_key, title,
        target_value, current_value, status, source
      ) VALUES (
        'old-goal', 'team', 'team-1', 'daily', '2026-07-25',
        '어제 목표', 1, 1, 'active', 'performance-governance'
      );
    `);
  });

  afterEach(() => db.close());

  it('uses KST daily, ISO weekly and KST monthly windows', () => {
    expect(getKstPerformancePeriods(now).map(window => ({
      period: window.period,
      key: window.key,
    }))).toEqual([
      { period: 'daily', key: '2026-07-26' },
      { period: 'weekly', key: '2026-W30' },
      { period: 'monthly', key: '2026-07' },
    ]);
  });

  it.each([
    ['2025-12-28T15:00:00.000Z', '2026-W01'],
    ['2020-12-31T03:00:00.000Z', '2020-W53'],
    ['2021-01-01T03:00:00.000Z', '2020-W53'],
    ['2023-01-01T03:00:00.000Z', '2022-W52'],
    ['2024-12-29T15:00:00.000Z', '2025-W01'],
  ])('computes ISO week keys correctly at %s', (instant, expectedWeek) => {
    const week = getKstPerformancePeriods(new Date(instant))
      .find(window => window.period === 'weekly');
    expect(week?.key).toBe(expectedWeek);
  });

  it('computes ISO week keys correctly across year boundaries', () => {
    // KST midnight helper: UTC instant equal to 00:00 KST on the given date.
    const kstMidnight = (y: number, m: number, d: number) =>
      new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 9 * 60 * 60 * 1000);

    // 2025-12-29 is a Monday; ISO week 1 of 2026 (2026-01-01 is a Thursday).
    expect(getKstPerformancePeriods(kstMidnight(2025, 12, 29))
      .find(w => w.period === 'weekly')?.key).toBe('2026-W01');
    // 2026-01-01 (Thursday) itself falls in the same ISO week.
    expect(getKstPerformancePeriods(kstMidnight(2026, 1, 1))
      .find(w => w.period === 'weekly')?.key).toBe('2026-W01');
    // 2020-12-31 (Thursday) belongs to ISO week 53 of 2020.
    expect(getKstPerformancePeriods(kstMidnight(2020, 12, 31))
      .find(w => w.period === 'weekly')?.key).toBe('2020-W53');
    // 2021-01-01 (Friday) still belongs to ISO week 53 of the *previous* ISO year.
    expect(getKstPerformancePeriods(kstMidnight(2021, 1, 1))
      .find(w => w.period === 'weekly')?.key).toBe('2020-W53');
    // 2023-01-01 (Sunday) belongs to ISO week 52 of 2022, not week 1 of 2023.
    expect(getKstPerformancePeriods(kstMidnight(2023, 1, 1))
      .find(w => w.period === 'weekly')?.key).toBe('2022-W52');
    // 2024-12-30 (Monday) already belongs to ISO week 1 of 2025.
    expect(getKstPerformancePeriods(kstMidnight(2024, 12, 30))
      .find(w => w.period === 'weekly')?.key).toBe('2025-W01');
  });

  it('covers every active subject at all three cadences and is idempotent', () => {
    const first = runPerformanceGovernance({ database: db, now });
    const second = runPerformanceGovernance({ database: db, now });

    expect(first).toMatchObject({
      activeOrganizations: 1,
      activeTeams: 1,
      goalsExpected: 6,
      goalsCreated: 6,
      goalsFinalized: 1,
      reportsExpected: 6,
      reportsCreated: 6,
      missingGoalsAfter: 0,
      missingReportsAfter: 0,
    });
    expect(second).toMatchObject({
      goalsCreated: 0,
      goalsUpdated: 6,
      reportsCreated: 0,
      reportsUpdated: 6,
      missingGoalsAfter: 0,
      missingReportsAfter: 0,
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM team_goals
      WHERE source = 'performance-governance' AND status = 'active'
    `).get()).toEqual({ count: 6 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM performance_reports
      WHERE source = 'performance-governance'
    `).get()).toEqual({ count: 6 });
    expect(db.prepare(`
      SELECT status FROM team_goals WHERE id = 'old-goal'
    `).get()).toEqual({ status: 'met' });
    expect(db.prepare(`
      SELECT current_value FROM team_goals
      WHERE subject_id = 'team-1' AND period = 'daily'
        AND period_key = '2026-07-26'
        AND source = 'performance-governance'
    `).get()).toEqual({ current_value: 1 });
    const report = db.prepare(`
      SELECT metrics_json FROM performance_reports
      WHERE subject_id = 'team-1' AND period = 'daily'
        AND source = 'performance-governance'
    `).get() as { metrics_json: string };
    const metrics = JSON.parse(report.metrics_json);
    expect(metrics.execution).toMatchObject({
      taskCompleted: 1,
      taskFailed: 1,
      terminalDenominator: 2,
      successRatePct: 50,
    });
    expect(metrics.guidance.nextAction).toContain('실패 1건');
  });

  it('has the supreme commander fail closed on stale automation or stalled work', () => {
    db.prepare(`DELETE FROM tasks WHERE id = 'failed'`).run();
    runPerformanceGovernance({ database: db, now });
    const insertCron = db.prepare(`
      INSERT INTO cron_jobs (
        id, schedule, timezone, task_type, enabled,
        last_run_at, last_status, created_at
      ) VALUES (?, ?, 'Asia/Seoul', 'internal', 1, ?, 'success', ?)
    `);
    for (const requirement of PERFORMANCE_CRON_REQUIREMENTS) {
      insertCron.run(
        requirement.id,
        requirement.schedule,
        '2026-07-26 02:30:00',
        '2026-07-26 00:00:00',
      );
    }

    const healthy = runCommanderOperationAudit({
      database: db,
      now,
      source: 'manual',
    });
    expect(healthy).toMatchObject({
      status: 'pass',
      goalsExpected: 6,
      goalsPresent: 6,
      reportsExpected: 6,
      reportsPresent: 6,
      schedulesHealthy: PERFORMANCE_CRON_REQUIREMENTS.length,
      checks: { orgDesign: { checked: false, available: false } },
    });

    db.prepare(`
      UPDATE cron_jobs SET enabled = 0
      WHERE id = 'pg-hourly-progress-refresh'
    `).run();
    db.prepare(`
      INSERT INTO tasks (
        id, team_id, status, created_at, updated_at, last_activity_at
      ) VALUES (
        'stalled', 'team-1', 'running',
        '2026-07-25T23:00:00.000Z', '2026-07-25T23:00:00.000Z',
        '2026-07-25T23:00:00.000Z'
      )
    `).run();
    const unhealthy = runCommanderOperationAudit({
      database: db,
      now,
      source: 'manual',
    });
    expect(unhealthy.status).toBe('fail');
    expect(unhealthy.stalledTasks).toBe(1);
    expect(unhealthy.schedulesHealthy).toBe(PERFORMANCE_CRON_REQUIREMENTS.length - 1);
    expect(unhealthy.evidence.join(' ')).toContain('자동화 예약 이상');
  });
});

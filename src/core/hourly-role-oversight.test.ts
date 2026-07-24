import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureDailyGoalCoverage,
  runHourlyRoleAudit,
  type SelfImprovementEvidence,
} from './hourly-role-oversight.js';

describe('hourly HR role and goal oversight', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        schedule TEXT
      );
      CREATE TABLE teams (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        charter TEXT,
        lead TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        is_always_on INTEGER NOT NULL DEFAULT 1,
        schedule TEXT
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        team_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE team_goals (
        id TEXT PRIMARY KEY,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        period TEXT NOT NULL,
        period_key TEXT NOT NULL,
        title TEXT NOT NULL,
        metric TEXT,
        target_value REAL,
        current_value REAL NOT NULL DEFAULT 0,
        unit TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        note TEXT,
        direction TEXT NOT NULL DEFAULT 'increase',
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX idx_test_hr_goal
        ON team_goals(subject_kind, subject_id, period, period_key, source)
        WHERE source = 'hr-daily-coverage';
      CREATE TABLE cron_jobs (
        id TEXT PRIMARY KEY,
        schedule TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        last_status TEXT
      );
      CREATE TABLE hourly_role_audits (
        id TEXT PRIMARY KEY,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        status TEXT NOT NULL,
        checks_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO organizations (id, name, slug, schedule) VALUES
        ('org_nova-ax', 'NOVA AX', 'nova-ax', NULL),
        ('org_nco-self', 'NCO Self', 'nco-self', '20 * * * *'),
        ('org_product', 'Product', 'product', NULL);
      INSERT INTO teams (
        id, organization_id, name, slug, charter, lead, schedule
      ) VALUES
        ('team_hr-director', 'org_nova-ax', 'HR', 'hr-director', 'Manage lifecycle', 'hermes', '*/10 * * * *'),
        ('team_self-improvement', 'org_nco-self', 'Self Improvement', 'self-improvement', 'Verify improvements', 'codex', NULL),
        ('team_product', 'org_product', 'Product Team', 'product-team', 'Ship verified work', 'codex', NULL);
      INSERT INTO cron_jobs (id, schedule, enabled, last_run_at, last_status) VALUES
        ('team-score-diagnostics', '*/10 * * * *', 1, '2026-07-24 00:55:00', 'success'),
        ('hr-weekly-workforce-planning', '0 9 * * 1', 1, NULL, NULL);
    `);
  });

  afterEach(() => db.close());

  it('rolls stale daily goals forward and covers every active team and organization exactly once', () => {
    db.prepare(`
      INSERT INTO team_goals (
        id, subject_kind, subject_id, period, period_key,
        title, target_value, current_value, status
      ) VALUES (
        'yesterday', 'team', 'team_product', 'daily', '2026-07-23',
        'Yesterday delivery', 1, 1, 'active'
      )
    `).run();
    db.prepare(`
      INSERT INTO tasks (id, team_id, status, created_at)
      VALUES ('completed-today', 'team_product', 'completed', '2026-07-24 00:30:00')
    `).run();

    const now = new Date('2026-07-24T01:00:00Z');
    const first = ensureDailyGoalCoverage(db, now);
    const second = ensureDailyGoalCoverage(db, now);

    expect(first).toMatchObject({
      periodKey: '2026-07-24',
      activeOrganizations: 3,
      activeTeams: 3,
      finalizedPreviousGoals: 1,
      createdOrganizationGoals: 3,
      createdTeamGoals: 3,
      missingAfter: 0,
    });
    expect(second).toMatchObject({
      createdOrganizationGoals: 0,
      createdTeamGoals: 0,
      missingAfter: 0,
    });
    expect(db.prepare(`
      SELECT status FROM team_goals WHERE id = 'yesterday'
    `).get()).toEqual({ status: 'met' });
    expect(db.prepare(`
      SELECT current_value
      FROM team_goals
      WHERE subject_id = 'team_product'
        AND period_key = '2026-07-24'
        AND source = 'hr-daily-coverage'
    `).get()).toEqual({ current_value: 1 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM team_goals
      WHERE period = 'daily' AND period_key = '2026-07-24'
    `).get()).toEqual({ count: 6 });
  });

  it('records hourly evidence that HR and the self-improvement company are doing their roles', () => {
    const evidence: SelfImprovementEvidence = {
      checklistDate: '2026-07-24',
      checkedAt: '2026-07-24T09:20:00+09:00',
      total: 208,
      passed: 205,
      failed: 2,
      skipped: 1,
      deferred: 0,
      dispatched: true,
      dispatchSkippedReason: null,
      readable: true,
    };

    const result = runHourlyRoleAudit({
      database: db,
      now: new Date('2026-07-24T01:00:00Z'),
      source: 'manual',
      selfImprovementEvidence: evidence,
    });

    expect(result.goalCoverage.missingAfter).toBe(0);
    expect(result.hr.status).toBe('pass');
    expect(result.selfImprovement.status).toBe('pass');
    expect(db.prepare(`
      SELECT subject_kind, status, source
      FROM hourly_role_audits
      ORDER BY subject_kind
    `).all()).toEqual([
      { subject_kind: 'hr', status: 'pass', source: 'manual' },
      { subject_kind: 'self-improvement', status: 'pass', source: 'manual' },
    ]);
  });
});

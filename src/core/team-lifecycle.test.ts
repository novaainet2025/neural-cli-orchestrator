import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamScore } from './team-scorer.js';
import {
  refreshRetirementWatchlist,
  runTeamLifecycleReview,
  runWeeklyWorkforcePlanning,
  TEAM_LIFECYCLE_MAX_IMPROVEMENTS,
} from './team-lifecycle.js';

function score(
  overrides: Partial<TeamScore> & Pick<TeamScore, 'teamId' | 'slug' | 'name'>,
): TeamScore {
  return {
    organizationId: 'org_product',
    score: 80,
    grade: 'B',
    completion: 80,
    n: 2,
    maxN: 0,
    sample: '48h',
    ...overrides,
  };
}

describe('HR team lifecycle policy', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE teams (
        id TEXT PRIMARY KEY,
        organization_id TEXT REFERENCES organizations(id),
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        description TEXT,
        color TEXT,
        lead TEXT,
        charter TEXT,
        is_always_on INTEGER NOT NULL DEFAULT 1,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE team_members (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id),
        member_type TEXT NOT NULL,
        member_ref TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        team_id TEXT REFERENCES teams(id),
        status TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE team_lifecycle_profiles (
        team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'active',
        improvement_count INTEGER NOT NULL DEFAULT 0,
        successful_improvement_count INTEGER NOT NULL DEFAULT 0,
        failed_improvement_count INTEGER NOT NULL DEFAULT 0,
        unresolved_improvement_count INTEGER NOT NULL DEFAULT 0,
        consecutive_low_checks INTEGER NOT NULL DEFAULT 0,
        last_score REAL,
        last_sample_size INTEGER NOT NULL DEFAULT 0,
        first_low_at TEXT,
        last_checked_at TEXT,
        last_improvement_at TEXT,
        active_run_id TEXT,
        retired_at TEXT,
        retirement_reason TEXT,
        protected INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE team_lifecycle_events (
        id TEXT PRIMARY KEY,
        team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
        team_slug TEXT NOT NULL,
        event_type TEXT NOT NULL,
        score REAL,
        improvement_count INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT '',
        company_run_id TEXT,
        source TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE hr_retirement_watchlist (
        id TEXT PRIMARY KEY,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        subject_slug TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'watchlisted',
        first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_at TEXT,
        reviewed_by TEXT
      );
      CREATE UNIQUE INDEX idx_watchlist_open
        ON hr_retirement_watchlist(subject_kind, subject_id)
        WHERE status = 'watchlisted';
      CREATE TABLE hr_weekly_org_actions (
        id TEXT PRIMARY KEY,
        week_key TEXT NOT NULL UNIQUE,
        action_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        subject_slug TEXT NOT NULL,
        based_on_goal_id TEXT,
        performance_reports_reviewed INTEGER NOT NULL DEFAULT 0,
        work_reports_reviewed INTEGER NOT NULL DEFAULT 0,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE team_goals (
        id TEXT PRIMARY KEY,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        title TEXT NOT NULL,
        target_value REAL,
        current_value REAL NOT NULL,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE performance_reports (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE work_reports (
        id TEXT PRIMARY KEY,
        report_kind TEXT NOT NULL DEFAULT 'work',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO organizations (id, name, slug, created_at) VALUES
        ('org_nova-ax', 'NOVA AX', 'nova-ax', '2026-01-01'),
        ('org_product', 'Product', 'product', '2026-01-01'),
        ('org_nco-self', 'NCO Self', 'nco-self', '2026-01-01');
      INSERT INTO teams (
        id, organization_id, name, slug, lead, is_active, created_at
      ) VALUES
        ('team_low', 'org_product', 'Low', 'low', 'hermes', 1, '2026-01-01'),
        ('team_other', 'org_product', 'Other', 'other', 'hermes', 1, '2026-01-01'),
        ('team_hr-director', 'org_nova-ax', 'HR', 'hr-director', 'hermes', 1, '2026-01-01'),
        ('team_self-improvement', 'org_nco-self', 'Self', 'self-improvement', 'codex', 1, '2026-01-01');
      INSERT INTO team_lifecycle_profiles (team_id, protected) VALUES
        ('team_hr-director', 1),
        ('team_self-improvement', 1);
    `);
  });

  afterEach(() => db.close());

  it('treats score 90 as healthy (at or above HR target)', async () => {
    const triggerImprovement = vi.fn();
    const result = await runTeamLifecycleReview({
      database: db,
      now: new Date('2026-07-23T00:00:00Z'),
      source: 'event',
      scores: [score({
        teamId: 'team_low',
        slug: 'low',
        name: 'Low',
        score: 90,
        grade: 'A',
        completion: 100,
      })],
      triggerImprovement,
    });

    expect(result.healthy).toBe(1);
    expect(result.belowOrEqualTarget).toBe(0);
    expect(result.improvementsStarted).toBe(0);
    expect(triggerImprovement).not.toHaveBeenCalled();
    expect(db.prepare(`
      SELECT improvement_count, status, active_run_id, consecutive_low_checks
      FROM team_lifecycle_profiles WHERE team_id = 'team_low'
    `).get()).toEqual({
      improvement_count: 0,
      status: 'active',
      active_run_id: null,
      consecutive_low_checks: 0,
    });
    expect(db.prepare(`
      SELECT event_type FROM team_lifecycle_events
      WHERE team_id = 'team_low'
      ORDER BY rowid
    `).all()).toEqual([
      { event_type: 'score_checked' },
    ]);
  });

  it('batches and deduplicates unchanged scheduled score events', async () => {
    const unchangedScore = score({
      teamId: 'team_low',
      slug: 'low',
      name: 'Low',
      score: 90,
      grade: 'A',
      completion: 100,
    });

    await runTeamLifecycleReview({
      database: db,
      source: 'scheduled',
      scores: [{ ...unchangedScore, n: unchangedScore.n + 1 }],
      triggerImprovement: vi.fn(),
    });
    await runTeamLifecycleReview({
      database: db,
      source: 'scheduled',
      scores: [unchangedScore],
      triggerImprovement: vi.fn(),
    });

    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM team_lifecycle_events
      WHERE team_id = 'team_low' AND event_type = 'score_checked'
    `).get()).toEqual({ count: 1 });
  });

  it('defers lifecycle action when only one terminal task is available', async () => {
    const triggerImprovement = vi.fn();
    const result = await runTeamLifecycleReview({
      database: db,
      now: new Date('2026-07-23T00:00:00Z'),
      source: 'event',
      scores: [score({
        teamId: 'team_low',
        slug: 'low',
        name: 'Low',
        score: 90,
        grade: 'A',
        completion: 100,
        n: 1,
        maxN: 10,
        sample: 'all',
      })],
      triggerImprovement,
    });

    expect(result).toMatchObject({
      evaluated: 1,
      insufficientSample: 1,
      belowOrEqualTarget: 0,
      improvementsStarted: 0,
    });
    expect(triggerImprovement).not.toHaveBeenCalled();
    expect(db.prepare(`
      SELECT improvement_count, unresolved_improvement_count, consecutive_low_checks,
             last_score, last_sample_size
      FROM team_lifecycle_profiles WHERE team_id = 'team_low'
    `).get()).toEqual({
      improvement_count: 0,
      unresolved_improvement_count: 0,
      consecutive_low_checks: 0,
      last_score: 90,
      last_sample_size: 1,
    });
    expect(db.prepare(`
      SELECT event_type, reason
      FROM team_lifecycle_events
      WHERE team_id = 'team_low'
    `).get()).toEqual({
      event_type: 'score_checked',
      reason: 'terminal task sample 1 is below minimum 2; lifecycle action deferred',
    });
  });

  it('does not mark a completed improvement unresolved from a one-task sample', async () => {
    const runId = 'run-insufficient-sample-regression';
    db.prepare(`
      INSERT INTO team_lifecycle_profiles (
        team_id, status, improvement_count, active_run_id
      ) VALUES ('team_low', 'improving', 1, ?)
    `).run(runId);
    db.prepare(`
      INSERT INTO tasks (id, team_id, status, metadata_json, created_at)
      VALUES ('improvement-task', 'team_self-improvement', 'completed', ?, ?)
    `).run(
      JSON.stringify({ companyRunId: runId }),
      '2026-07-23T00:00:00Z',
    );

    const result = await runTeamLifecycleReview({
      database: db,
      now: new Date('2026-07-23T00:10:00Z'),
      scores: [score({
        teamId: 'team_low',
        slug: 'low',
        name: 'Low',
        score: 90,
        grade: 'A',
        completion: 100,
        n: 1,
        maxN: 10,
        sample: 'all',
      })],
      triggerImprovement: vi.fn(),
    });

    expect(result.insufficientSample).toBe(1);
    expect(db.prepare(`
      SELECT active_run_id, successful_improvement_count, unresolved_improvement_count
      FROM team_lifecycle_profiles WHERE team_id = 'team_low'
    `).get()).toEqual({
      active_run_id: null,
      successful_improvement_count: 1,
      unresolved_improvement_count: 0,
    });
    expect(db.prepare(`
      SELECT reason FROM team_lifecycle_events
      WHERE team_id = 'team_low' AND event_type = 'improvement_completed'
    `).get()).toEqual({
      reason: 'improvement run completed; score evaluation deferred with sample 1/2',
    });
  });

  it('does not exceed five active nco-self improvement company runs across review cycles', async () => {
    const insertTeam = db.prepare(`
      INSERT INTO teams (
        id, organization_id, name, slug, lead, is_active, created_at
      ) VALUES (?, 'org_product', ?, ?, 'hermes', 1, '2026-01-01')
    `);
    const insertProfile = db.prepare(`
      INSERT INTO team_lifecycle_profiles (team_id, status, active_run_id)
      VALUES (?, 'improving', ?)
    `);
    for (let index = 0; index < 5; index += 1) {
      insertTeam.run(`team_active_${index}`, `Active ${index}`, `active-${index}`);
      insertProfile.run(`team_active_${index}`, `active-run-${index}`);
    }
    const triggerImprovement = vi.fn();

    const result = await runTeamLifecycleReview({
      database: db,
      now: new Date('2026-07-23T00:00:00Z'),
      scores: [score({ teamId: 'team_low', slug: 'low', name: 'Low' })],
      triggerImprovement,
    });

    expect(result.belowOrEqualTarget).toBe(1);
    expect(result.improvementsStarted).toBe(0);
    expect(triggerImprovement).not.toHaveBeenCalled();
  });

  it('audits nco-self teams without recursively launching the same improvement company', async () => {
    db.prepare(`
      INSERT INTO teams (
        id, organization_id, name, slug, lead, is_active, created_at
      ) VALUES (
        'team_self-learning', 'org_nco-self', 'Self Learning',
        'self-learning', 'codex', 1, '2026-01-01'
      )
    `).run();
    db.prepare(`
      INSERT INTO team_lifecycle_profiles (
        team_id, status, improvement_count, active_run_id, protected
      ) VALUES (
        'team_self-learning', 'probation', 2, 'stale-recursive-run', 1
      )
    `).run();
    const triggerImprovement = vi.fn();

    const result = await runTeamLifecycleReview({
      database: db,
      now: new Date('2026-07-23T00:00:00Z'),
      scores: [score({
        teamId: 'team_self-learning',
        slug: 'self-learning',
        name: 'Self Learning',
        organizationId: 'org_nco-self',
      })],
      triggerImprovement,
    });

    expect(result.belowOrEqualTarget).toBe(1);
    expect(result.protectedFromRetirement).toBe(1);
    expect(triggerImprovement).not.toHaveBeenCalled();
    expect(db.prepare(`
      SELECT protected, status, active_run_id
      FROM team_lifecycle_profiles
      WHERE team_id = 'team_self-learning'
    `).get()).toEqual({
      protected: 1,
      status: 'active',
      active_run_id: null,
    });
  });

  it('soft-retires a team after three completed improvements leave it below target', async () => {
    let run = 0;
    const triggerImprovement = vi.fn(async () => ({
      ok: true,
      runId: `run-${++run}`,
    }));
    const lowScore = score({ teamId: 'team_low', slug: 'low', name: 'Low' });

    for (let cycle = 0; cycle < TEAM_LIFECYCLE_MAX_IMPROVEMENTS; cycle += 1) {
      const now = new Date(Date.UTC(2026, 6, 23, 0, cycle * 10));
      await runTeamLifecycleReview({
        database: db,
        now,
        scores: [lowScore],
        triggerImprovement,
      });
      db.prepare(`
        INSERT INTO tasks (id, team_id, status, metadata_json, created_at)
        VALUES (?, 'team_self-improvement', 'completed', ?, ?)
      `).run(
        `improvement-task-${cycle + 1}`,
        JSON.stringify({ companyRunId: `run-${cycle + 1}` }),
        now.toISOString(),
      );
    }

    const result = await runTeamLifecycleReview({
      database: db,
      now: new Date('2026-07-23T00:30:00Z'),
      scores: [lowScore],
      triggerImprovement,
    });

    expect(triggerImprovement).toHaveBeenCalledTimes(TEAM_LIFECYCLE_MAX_IMPROVEMENTS);
    expect(result.retiredPersistent).toBe(1);
    expect(db.prepare(`
      SELECT is_active, is_always_on FROM teams WHERE id = 'team_low'
    `).get()).toEqual({ is_active: 0, is_always_on: 0 });
    expect(db.prepare(`
      SELECT status, improvement_count, unresolved_improvement_count
      FROM team_lifecycle_profiles WHERE team_id = 'team_low'
    `).get()).toEqual({
      status: 'retired',
      improvement_count: 3,
      unresolved_improvement_count: 3,
    });
  });

  it('immediately soft-retires a non-protected team that dominates company failures', async () => {
    const insert = db.prepare(`
      INSERT INTO tasks (id, team_id, status, created_at)
      VALUES (?, ?, ?, '2026-07-23T00:00:00Z')
    `);
    for (let index = 0; index < 8; index += 1) {
      insert.run(`low-failure-${index}`, 'team_low', 'failed');
    }
    for (let index = 0; index < 2; index += 1) {
      insert.run(`other-failure-${index}`, 'team_other', 'failed');
    }
    const triggerImprovement = vi.fn();
    const result = await runTeamLifecycleReview({
      database: db,
      now: new Date('2026-07-23T01:00:00Z'),
      scores: [score({
        teamId: 'team_low',
        slug: 'low',
        name: 'Low',
        score: 18,
        grade: 'F',
        completion: 20,
        n: 10,
        sample: 'all',
      })],
      triggerImprovement,
    });

    expect(result.retiredImmediate).toBe(1);
    expect(triggerImprovement).not.toHaveBeenCalled();
    expect(db.prepare(`
      SELECT status, retirement_reason
      FROM team_lifecycle_profiles WHERE team_id = 'team_low'
    `).get()).toMatchObject({ status: 'retired' });
  });

  it('creates one evidence-backed incubation team per week and watchlists unused units', async () => {
    db.prepare(`
      INSERT INTO team_goals (
        id, subject_kind, subject_id, title, target_value,
        current_value, direction, status, updated_at
      ) VALUES (
        'goal-low', 'organization', 'org_product', 'Reduce delivery failures',
        2, 10, 'decrease', 'active', '2026-07-22'
      )
    `).run();
    db.prepare(`
      INSERT INTO performance_reports (id, created_at)
      VALUES ('performance-1', '2026-07-22')
    `).run();
    db.prepare(`
      INSERT INTO work_reports (id, report_kind, created_at)
      VALUES ('work-1', 'goal', '2026-07-22')
    `).run();

    const now = new Date('2026-07-23T02:00:00Z');
    const first = await runWeeklyWorkforcePlanning(db, now);
    const second = await runWeeklyWorkforcePlanning(db, now);

    expect(first).toMatchObject({
      weekKey: '2026-W30',
      alreadyCompleted: false,
      actionType: 'team_created',
      basedOnGoalId: 'goal-low',
      performanceReportsReviewed: 1,
      workReportsReviewed: 1,
    });
    expect(second).toMatchObject({
      weekKey: '2026-W30',
      alreadyCompleted: true,
      subjectId: first.subjectId,
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM hr_weekly_org_actions
    `).get()).toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT organization_id, lead, is_always_on, is_active
      FROM teams WHERE id = ?
    `).get(first.subjectId)).toEqual({
      organization_id: 'org_product',
      lead: 'hermes',
      is_always_on: 0,
      is_active: 1,
    });

    const watchlist = refreshRetirementWatchlist(db, now);
    expect(watchlist.teamCandidates).toBeGreaterThan(0);
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM hr_retirement_watchlist
      WHERE status = 'watchlisted'
    `).get()).toMatchObject({ count: expect.any(Number) });
  });
});

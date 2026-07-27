import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerPerformanceRoutes } from './performance.js';

describe('performance routes', () => {
  let database: Database.Database;

  beforeEach(() => {
    database = new Database(':memory:');
    database.exec(`
      CREATE TABLE organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE teams (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        name TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        team_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
        current_value REAL NOT NULL,
        unit TEXT,
        status TEXT NOT NULL,
        note TEXT,
        direction TEXT
      );
      CREATE TABLE performance_reports (
        id TEXT PRIMARY KEY,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        period TEXT NOT NULL,
        period_key TEXT NOT NULL,
        metrics_json TEXT,
        reflection TEXT,
        improvement TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO organizations VALUES ('org-1', '회사 1');
      INSERT INTO teams VALUES ('team-1', 'org-1', '팀 1');
      INSERT INTO tasks (id, team_id, status) VALUES
        ('task-completed', 'team-1', 'completed'),
        ('task-failed-1', 'team-1', 'failed'),
        ('task-failed-2', 'team-1', 'failed'),
        ('task-timeout', 'team-1', 'timed_out'),
        ('task-lease', 'team-1', 'lease_expired'),
        ('task-running', 'team-1', 'running'),
        ('task-cancelled', 'team-1', 'cancelled');
      INSERT INTO team_goals (
        id, subject_kind, subject_id, period, period_key, title, metric,
        target_value, current_value, unit, status, direction
      ) VALUES
        ('goal-daily', 'organization', 'org-1', 'daily', '2026-07-28',
          '일일 실행 커버리지', 'active_team_execution_coverage_pct', 100, 100, '%', 'active', 'increase'),
        ('goal-weekly', 'organization', 'org-1', 'weekly', '2026-W31',
          '주간 실행 커버리지', 'active_team_execution_coverage_pct', 100, 100, '%', 'active', 'increase'),
        ('goal-monthly', 'organization', 'org-1', 'monthly', '2026-07',
          '월간 실행 커버리지', 'active_team_execution_coverage_pct', 100, 100, '%', 'active', 'increase');
    `);
  });

  afterEach(() => database.close());

  it('reconciles raw task counts and exposes why task success and goal attainment can diverge', async () => {
    const app = Fastify();
    registerPerformanceRoutes(app, database);

    const response = await app.inject({
      method: 'GET',
      url: '/api/performance?subjectId=org-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      taskCount: 7,
      terminalCount: 5,
      completed: 1,
      failed: 4,
      successRate: 20,
      excludedFromRateCount: 2,
      taskStatusCounts: {
        completed: 1,
        failed: 2,
        timed_out: 1,
        lease_expired: 1,
        running: 1,
        cancelled: 1,
      },
      goalCount: 3,
      goalMetricCount: 1,
      goalAttainment: 100,
      compositeScore: 52,
      definitions: {
        taskSuccessRate: { numerator: 1, denominator: 5 },
        goalAttainment: { activeGoals: 3, distinctMetrics: 1 },
        compositeScore: { comparable: false, status: 'reference-only-mixed-scope' },
      },
      dataQuality: {
        taskStatusCountsReconciled: true,
        terminalCountsReconciled: true,
        metricScopesAligned: false,
      },
    });
    expect(response.json().dataQuality.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('직접 비교할 수 없습니다'),
      expect.stringContaining('낮은 태스크 성공률'),
    ]));
    await app.close();
  });

  it('stores the same auditable metric contract in manually recorded reports', async () => {
    const app = Fastify();
    registerPerformanceRoutes(app, database);

    const created = await app.inject({
      method: 'POST',
      url: '/api/performance/reports',
      payload: {
        subjectId: 'org-1',
        period: 'daily',
        periodKey: '2026-07-28',
        reflection: '원인 점검',
        improvement: '실패 복구',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().metrics).toMatchObject({
      taskCount: 7,
      terminalCount: 5,
      successRate: 20,
      goalCount: 3,
      goalMetricCount: 1,
      goalAttainment: 100,
    });

    const reports = await app.inject({
      method: 'GET',
      url: '/api/performance/reports?subjectId=org-1',
    });
    expect(reports.statusCode).toBe(200);
    expect(reports.json().reports[0].metrics).toMatchObject({
      successRate: 20,
      goalAttainment: 100,
      definitions: {
        taskSuccessRate: { denominator: 5 },
      },
    });
    await app.close();
  });
});

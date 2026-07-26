import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerPerformanceFlowRoutes } from './performance-flow.js';

describe('performance flow routes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE organizations (
        id TEXT PRIMARY KEY, name TEXT, is_active INTEGER, is_always_on INTEGER
      );
      CREATE TABLE teams (
        id TEXT PRIMARY KEY, organization_id TEXT, name TEXT,
        is_active INTEGER, is_always_on INTEGER
      );
      CREATE TABLE team_goals (
        id TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT,
        period TEXT, period_key TEXT, source TEXT
      );
      CREATE TABLE performance_reports (
        id TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT,
        period TEXT, period_key TEXT, metrics_json TEXT, source TEXT
      );
      CREATE TABLE commander_operation_audits (
        id TEXT PRIMARY KEY, audit_time TEXT, source TEXT, status TEXT,
        checks_json TEXT, evidence_json TEXT
      );
      INSERT INTO organizations VALUES ('org-1', '회사 1', 1, 1);
      INSERT INTO teams VALUES ('team-1', 'org-1', '팀 1', 1, 1);
    `);
    const currentDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const insertGoal = db.prepare(`
      INSERT INTO team_goals VALUES (?, ?, ?, 'daily', ?, 'performance-governance')
    `);
    const insertReport = db.prepare(`
      INSERT INTO performance_reports VALUES (
        ?, ?, ?, 'daily', ?, ?, 'performance-governance'
      )
    `);
    for (const [kind, id] of [['organization', 'org-1'], ['team', 'team-1']] as const) {
      insertGoal.run(`goal-${id}`, kind, id, currentDay);
      insertReport.run(
        `report-${id}`,
        kind,
        id,
        currentDay,
        JSON.stringify({
          goal: { attainmentPct: 75 },
          execution: { taskCompleted: 3, taskFailed: 1, terminalDenominator: 4 },
          workReports: { due: 2, submitted: 1 },
          source: { freshnessAt: '2026-07-26T03:00:00.000Z' },
        }),
      );
    }
    db.prepare(`
      INSERT INTO commander_operation_audits
      VALUES ('audit-1', '2026-07-26T03:00:00.000Z', 'manual', 'attention', ?, ?)
    `).run(JSON.stringify({ coverage: true }), JSON.stringify(['실패 1건']));
  });

  afterEach(() => db.close());

  it('returns chart-ready aggregate series, coverage and commander evidence', async () => {
    const app = Fastify();
    registerPerformanceFlowRoutes(app, { database: () => db });

    const flowResponse = await app.inject({
      method: 'GET',
      url: '/api/performance-flow?period=daily&limit=12',
    });
    expect(flowResponse.statusCode).toBe(200);
    const flow = flowResponse.json();
    expect(flow.currentCoverage).toMatchObject({
      goalsExpected: 2,
      goalsPresent: 2,
      reportsExpected: 2,
      reportsPresent: 2,
      goalCoveragePct: 100,
      reportCoveragePct: 100,
    });
    expect(flow.series[0]).toMatchObject({
      subjectReports: 2,
      goalAttainmentPct: 75,
      taskCompleted: 6,
      failedTasks: 2,
      taskSuccessRatePct: 75,
      workReportSubmissionRatePct: 50,
    });

    const auditResponse = await app.inject({
      method: 'GET',
      url: '/api/commander/operations?limit=1',
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(auditResponse.json().latest).toMatchObject({
      id: 'audit-1',
      status: 'attention',
      checks: { coverage: true },
      evidence: ['실패 1건'],
    });
    await app.close();
  });
});

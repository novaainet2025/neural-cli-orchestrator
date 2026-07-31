import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorkflowRun, evaluateWorkflowPolicy } from '../../core/workflow-gate.js';
import { getDb } from '../../storage/database.js';
import { registerTeamsRoutes, summarizeTeamWorkflow } from './teams.js';

describe('team workflow routes', () => {
  let app: FastifyInstance;
  const orgId = 'org-workflow-route-test';
  const teamId = 'team-workflow-route-test';

  beforeAll(async () => {
    app = Fastify();
    await registerTeamsRoutes(app);
    await app.ready();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare(`
      INSERT OR IGNORE INTO organizations (id, name, slug)
      VALUES (?, 'Workflow Route Test', 'workflow-route-test')
    `).run(orgId);
    db.prepare(`
      INSERT OR IGNORE INTO teams (id, organization_id, name, slug)
      VALUES (?, ?, 'Workflow Route Team', 'workflow-route-team')
    `).run(teamId, orgId);
  });

  afterEach(() => {
    const db = getDb();
    db.prepare(`DELETE FROM workflow_runs WHERE team_id=?`).run(teamId);
    db.prepare(`DELETE FROM tasks WHERE team_id=?`).run(teamId);
    db.prepare(`DELETE FROM teams WHERE id=?`).run(teamId);
    db.prepare(`DELETE FROM organizations WHERE id=?`).run(orgId);
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps skipped distinct from never executed in legacy summaries', () => {
    const summary = summarizeTeamWorkflow([
      { mode: 'discussion', status: 'skipped', prompt: 'routine' },
      { mode: 'task', status: 'completed', prompt: 'implementation' },
    ]);
    expect(summary.discussion.skipped).toBe(1);
    expect(summary.discussion.completed).toBe(0);
    expect(summary.implementation.completed).toBe(1);
  });

  it('aggregates legacy task workflow state without loading every task row', async () => {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO tasks (id, mode, prompt, status, team_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run('task-team-summary-discussion', 'discussion', '의견 수집', 'cancelled', teamId, '2026-07-31 01:00:00');
    insert.run('task-team-summary-review', 'task', 'Review the patch', 'completed', teamId, '2026-07-31 01:01:00');
    insert.run('task-team-summary-verify', 'task', 'run E2E validation', 'failed', teamId, '2026-07-31 01:02:00');
    insert.run('task-team-summary-design', 'task', 'Architecture 설계', 'queued', teamId, '2026-07-31 01:03:00');
    insert.run('task-team-summary-implementation', 'task', '기능 구현', 'running', teamId, '2026-07-31 01:04:00');

    const response = await app.inject({ method: 'GET', url: '/api/teams' });
    expect(response.statusCode).toBe(200);
    const team = response.json().teams.find((entry: { id: string }) => entry.id === teamId);
    expect(team.workflow).toMatchObject({
      discussion: { failed: 1 },
      review: { completed: 1 },
      verification: { failed: 1 },
      design: { pending: 1 },
      implementation: { running: 1 },
    });
    expect(team.activeTask).toBe('기능 구현');
    expect(team.status).toBe('working');
  });

  it('serves durable workflow stages and their skip reasons', async () => {
    const prompt = '[업무보고 작성] 오늘 결과';
    const metadata = { teamId, workReportId: 'wr-route-test' };
    const runId = createWorkflowRun({
      prompt,
      teamId,
      metadata,
      decision: evaluateWorkflowPolicy(prompt, metadata),
    });

    const teamsResponse = await app.inject({ method: 'GET', url: '/api/teams' });
    expect(teamsResponse.statusCode).toBe(200);
    const team = teamsResponse.json().teams.find((entry: { id: string }) => entry.id === teamId);
    expect(team.workflow.discussion).toMatchObject({ skipped: 1, completed: 0 });
    expect(team.workflow.implementation).toMatchObject({ pending: 1, skipped: 0 });

    const tasksResponse = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/tasks?limit=10`,
    });
    expect(tasksResponse.statusCode).toBe(200);
    const stages = tasksResponse.json().tasks;
    expect(stages).toHaveLength(5);
    expect(stages.find((entry: { stage: string }) => entry.stage === 'discussion'))
      .toMatchObject({
        workflow_run_id: runId,
        status: 'skipped',
        required: false,
        skip_reason: 'routine_or_report',
      });
  });
});

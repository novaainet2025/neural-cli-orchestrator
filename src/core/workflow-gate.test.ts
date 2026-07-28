import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attachWorkflowTask,
  createWorkflowRun,
  enforceWorkflowPrerequisites,
  evaluateWorkflowPolicy,
  failStaleDiscussions,
  linkWorkflowDiscussion,
  markWorkflowStage,
  reconcileTerminalWorkflowTasks,
  syncWorkflowTask,
} from './workflow-gate.js';

describe('durable workflow gate', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE teams (id TEXT PRIMARY KEY);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        status TEXT,
        team_id TEXT REFERENCES teams(id),
        assigned_to TEXT,
        response TEXT,
        error TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE discussions (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        task_id TEXT,
        report TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT,
        ended_at TEXT
      );
      INSERT INTO teams (id) VALUES ('team-a'), ('team-b');
    `);
    db.exec(readFileSync(resolve('db/migrations/095_explicit_workflow_stages.sql'), 'utf8'));
  });

  afterEach(() => db.close());

  it('requires planning for non-routine team work and records routine skips', () => {
    const complex = evaluateWorkflowPolicy('신규 기능 아키텍처를 구현한다', { teamId: 'team-a' });
    const routine = evaluateWorkflowPolicy('[업무보고 작성] 오늘 결과', {
      teamId: 'team-a',
      workReportId: 'wr-1',
    });

    expect(complex).toMatchObject({
      scoped: true,
      required: true,
      requireReview: true,
      requireVerification: true,
    });
    expect(routine).toMatchObject({ scoped: true, required: false, policy: 'routine' });

    const runId = createWorkflowRun({
      prompt: '[업무보고 작성] 오늘 결과',
      teamId: 'team-a',
      metadata: { teamId: 'team-a', workReportId: 'wr-1' },
      decision: routine,
    }, db);
    const stages = db.prepare(`
      SELECT stage, status, required, skip_reason
      FROM workflow_stages WHERE workflow_run_id=? ORDER BY ordinal
    `).all(runId) as Array<Record<string, unknown>>;

    expect(stages).toHaveLength(5);
    expect(stages.filter(stage => stage.status === 'skipped')).toHaveLength(4);
    expect(stages.find(stage => stage.stage === 'implementation')).toMatchObject({
      status: 'pending',
      required: 1,
    });
  });

  it('blocks implementation until required discussion and design are complete', () => {
    const metadata = { teamId: 'team-a' };
    expect(enforceWorkflowPrerequisites(metadata, 'task', '신규 기능 구현', db))
      .toMatchObject({
        allowed: false,
        error: 'workflow_prerequisites_required',
        requiredStage: 'discussion',
      });

    const runId = createWorkflowRun({
      prompt: '신규 기능 구현',
      teamId: 'team-a',
      metadata,
    }, db);
    const linked = { ...metadata, workflowRunId: runId, workflowStage: 'implementation' };
    expect(enforceWorkflowPrerequisites(linked, 'task', '신규 기능 구현', db))
      .toMatchObject({ allowed: false, requiredStage: 'discussion' });

    markWorkflowStage(runId, 'discussion', 'completed', { teamId: 'team-a' }, db);
    expect(enforceWorkflowPrerequisites(linked, 'task', '신규 기능 구현', db))
      .toMatchObject({ allowed: false, requiredStage: 'design' });

    markWorkflowStage(runId, 'design', 'completed', { teamId: 'team-a' }, db);
    expect(enforceWorkflowPrerequisites(linked, 'task', '신규 기능 구현', db))
      .toMatchObject({ allowed: true, workflowRunId: runId, workflowStage: 'implementation' });
  });

  it('persists five stages per team and synchronizes task completion', () => {
    const runId = createWorkflowRun({
      prompt: '보안 migration 구현',
      teamIds: ['team-a', 'team-b'],
      companyRunId: 'company-1',
      metadata: { companyRunId: 'company-1', workflowRequired: true },
    }, db);
    expect(db.prepare('SELECT COUNT(*) AS count FROM workflow_stages WHERE workflow_run_id=?')
      .get(runId)).toEqual({ count: 10 });

    markWorkflowStage(runId, 'discussion', 'completed', {}, db);
    markWorkflowStage(runId, 'design', 'completed', {}, db);
    db.prepare(`
      INSERT INTO tasks (id, status, team_id, assigned_to)
      VALUES ('task-1', 'running', 'team-a', 'codex')
    `).run();
    attachWorkflowTask('task-1', runId, 'implementation', 'team-a', 'codex', db);
    syncWorkflowTask('task-1', 'completed', { evidence: { test: 'passed' } }, db);

    const stage = db.prepare(`
      SELECT status, task_id, executor, evidence_json
      FROM workflow_stages
      WHERE workflow_run_id=? AND team_id='team-a' AND stage='implementation'
    `).get(runId) as Record<string, unknown>;
    expect(stage).toMatchObject({ status: 'completed', task_id: 'task-1', executor: 'codex' });
    expect(JSON.parse(String(stage.evidence_json))).toEqual({ test: 'passed' });
  });

  it('fails stale discussions and their linked required stage', () => {
    const runId = createWorkflowRun({
      prompt: '신규 기능 구현',
      teamId: 'team-a',
      metadata: { teamId: 'team-a' },
    }, db);
    db.prepare(`
      INSERT INTO discussions (id, topic, status, updated_at)
      VALUES ('discussion-1', 'topic', 'active', datetime('now', '-2 hours'))
    `).run();
    linkWorkflowDiscussion('discussion-1', runId, { teamId: 'team-a' }, db);
    db.prepare(`
      UPDATE discussions SET updated_at=datetime('now', '-2 hours') WHERE id='discussion-1'
    `).run();

    expect(failStaleDiscussions(60_000, db)).toBe(1);
    expect(db.prepare(`SELECT status, report FROM discussions WHERE id='discussion-1'`).get())
      .toEqual({ status: 'failed', report: 'discussion_stale_timeout' });
    expect(db.prepare(`
      SELECT status, error FROM workflow_stages
      WHERE workflow_run_id=? AND team_id='team-a' AND stage='discussion'
    `).get(runId)).toEqual({ status: 'failed', error: 'discussion_stale_timeout' });
  });

  it('reconciles terminal tasks and active discussions after a restart', () => {
    const runId = createWorkflowRun({
      prompt: '신규 기능 구현',
      teamId: 'team-a',
      metadata: { teamId: 'team-a' },
    }, db);
    db.prepare(`
      INSERT INTO tasks (
        id, status, team_id, assigned_to, error, workflow_run_id, workflow_stage
      ) VALUES ('task-restart', 'cancelled', 'team-a', 'hermes',
                'orphaned: restart', ?, 'discussion')
    `).run(runId);
    db.prepare(`
      INSERT INTO discussions (id, topic, status, task_id, workflow_run_id)
      VALUES ('discussion-restart', 'topic', 'active', 'task-restart', ?)
    `).run(runId);
    markWorkflowStage(runId, 'discussion', 'running', {
      teamId: 'team-a',
      taskId: 'task-restart',
      discussionId: 'discussion-restart',
    }, db);

    expect(reconcileTerminalWorkflowTasks(db)).toBe(1);
    expect(db.prepare(`
      SELECT status, error FROM workflow_stages
      WHERE workflow_run_id=? AND team_id='team-a' AND stage='discussion'
    `).get(runId)).toEqual({ status: 'cancelled', error: 'orphaned: restart' });
    expect(db.prepare(`
      SELECT status, report FROM discussions WHERE id='discussion-restart'
    `).get()).toEqual({ status: 'failed', report: 'orphaned: restart' });
    expect(db.prepare(`
      SELECT status FROM workflow_runs WHERE id=?
    `).get(runId)).toEqual({ status: 'cancelled' });
  });

  it('repairs a completed workflow stage when the final quality gate rejects its task', () => {
    const runId = createWorkflowRun({
      prompt: '신규 기능 구현',
      teamId: 'team-a',
      metadata: { teamId: 'team-a' },
    }, db);
    markWorkflowStage(runId, 'discussion', 'completed', { teamId: 'team-a' }, db);
    markWorkflowStage(runId, 'design', 'completed', { teamId: 'team-a' }, db);
    db.prepare(`
      INSERT INTO tasks (id, status, team_id, assigned_to)
      VALUES ('task-quality', 'running', 'team-a', 'nvidia')
    `).run();
    attachWorkflowTask('task-quality', runId, 'implementation', 'team-a', 'nvidia', db);
    syncWorkflowTask('task-quality', 'completed', {}, db);
    db.prepare(`
      UPDATE tasks
      SET status='failed', error='quality_rejected: FORMAT_MISMATCH'
      WHERE id='task-quality'
    `).run();

    expect(reconcileTerminalWorkflowTasks(db)).toBe(1);
    expect(db.prepare(`
      SELECT status, error FROM workflow_stages
      WHERE workflow_run_id=? AND team_id='team-a' AND stage='implementation'
    `).get(runId)).toEqual({
      status: 'failed',
      error: 'quality_rejected: FORMAT_MISMATCH',
    });
    expect(db.prepare(`
      SELECT status FROM workflow_runs WHERE id=?
    `).get(runId)).toEqual({ status: 'failed' });
  });

  it('replaces stale failure evidence when a retry completes the stage', () => {
    const runId = createWorkflowRun({
      prompt: '신규 기능 구현',
      teamId: 'team-a',
      metadata: { teamId: 'team-a' },
    }, db);
    markWorkflowStage(runId, 'discussion', 'completed', { teamId: 'team-a' }, db);
    markWorkflowStage(runId, 'design', 'completed', { teamId: 'team-a' }, db);
    db.prepare(`
      INSERT INTO tasks (id, status, team_id, assigned_to)
      VALUES ('task-failed', 'failed', 'team-a', 'nvidia')
    `).run();
    attachWorkflowTask('task-failed', runId, 'implementation', 'team-a', 'nvidia', db);
    syncWorkflowTask('task-failed', 'failed', {
      error: 'quality_rejected',
      evidence: { source: 'startup_terminal_task_reconciliation', taskStatus: 'failed' },
    }, db);

    db.prepare(`
      INSERT INTO tasks (id, status, team_id, assigned_to)
      VALUES ('task-retry', 'completed', 'team-a', 'cursor-agent')
    `).run();
    attachWorkflowTask('task-retry', runId, 'implementation', 'team-a', 'cursor-agent', db);
    syncWorkflowTask('task-retry', 'completed', {}, db);

    const stage = db.prepare(`
      SELECT status, task_id, executor, error, evidence_json
      FROM workflow_stages
      WHERE workflow_run_id=? AND team_id='team-a' AND stage='implementation'
    `).get(runId) as Record<string, unknown>;
    expect(stage).toMatchObject({
      status: 'completed',
      task_id: 'task-retry',
      executor: 'cursor-agent',
      error: null,
    });
    expect(JSON.parse(String(stage.evidence_json))).toEqual({
      source: 'task_terminal_sync',
      taskStatus: 'completed',
    });
  });
});

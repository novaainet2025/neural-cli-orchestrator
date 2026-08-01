import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { agentManager } from '../agent/agent-manager.js';
import { kanbanEngine } from '../core/kanban-engine.js';
import { discussionEngine } from '../core/discussion-engine.js';
import { providerRuntimeCoordinator } from '../core/provider-runtime-coordinator.js';
import { smartRouter } from '../core/smart-router.js';
import { taskQueue } from '../core/task-queue.js';
import { attachWorkflowTask, createWorkflowRun } from '../core/workflow-gate.js';
import { closeDb, getDb, runMigrations } from '../storage/database.js';
import { resolveInternalProjectDir } from '../utils/project-dir.js';
import { createGateway, loadRetryPayload } from './gateway.js';

describe.sequential('gateway retry contract', () => {
  const originalDatabasePath = process.env.DATABASE_PATH;
  const originalAxNcoSecret = process.env.AX_NCO_SECRET;
  let testDir: string | undefined;
  let testDbPath: string | undefined;
  let server: Awaited<ReturnType<typeof createGateway>>;

  beforeAll(async () => {
    closeDb();
    testDir = mkdtempSync(resolve(tmpdir(), 'nco-gateway-retry-'));
    testDbPath = resolve(testDir, 'gateway-retry.db');
    process.env.DATABASE_PATH = testDbPath;
    process.env.AX_NCO_SECRET = 'gateway-retry-contract-secret';
    runMigrations();
    await agentManager.init();
    vi.spyOn(taskQueue, 'enqueue').mockResolvedValue({
      success: true,
      output: `done: ${'retry contract verified '.repeat(40)}`,
      status: 'completed',
    });
    server = await createGateway();
    expect(kanbanEngine.createTaskRef).toBeTypeOf('function');
    expect(kanbanEngine.createRetryTaskRef).toBeTypeOf('function');
    expect(kanbanEngine.replaceActiveTaskRef).toBeTypeOf('function');
  });

  afterAll(async () => {
    try {
      await server?.close();
    } finally {
      agentManager.destroy();
      closeDb();
      if (testDir) rmSync(testDir, { recursive: true, force: true });
      if (originalDatabasePath === undefined) {
        delete process.env.DATABASE_PATH;
      } else {
        process.env.DATABASE_PATH = originalDatabasePath;
      }
      if (originalAxNcoSecret === undefined) {
        delete process.env.AX_NCO_SECRET;
      } else {
        process.env.AX_NCO_SECRET = originalAxNcoSecret;
      }
      vi.restoreAllMocks();
      kanbanEngine.createTaskRef = null;
      kanbanEngine.createRetryTaskRef = null;
      kanbanEngine.replaceActiveTaskRef = null;
    }
  });

  it('replaces the prompt while preserving the source project and execution contract', async () => {
    const db = getDb();
    const verifier = { type: 'run', command: 'true', timeoutMs: 12_000 } as const;
    const replacementPrompt = [
      '[컨텍스트] retry payload contract',
      '[목표] use only the replacement prompt',
      '[제약] preserve inherited execution fields',
      '[출력형식] plain text',
      '[검증기준] inspect the persisted child task',
    ].join('\n');

    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES (?, 'task', ?, 'codex', 'failed')
    `).run('retry-root', 'root prompt');
    db.prepare(`
      INSERT INTO tasks (
        id, mode, prompt, system_prompt, assigned_to, status, workspace_id,
        priority, verifier_json, metadata_json, parent_task_id
      ) VALUES (?, 'task', ?, ?, 'codex', 'failed', ?, ?, ?, ?, ?)
    `).run(
      'retry-attempt',
      'original prompt must be replaced',
      'preserved system prompt',
      'retry-workspace',
      8,
      JSON.stringify(verifier),
      JSON.stringify({
        projectDir: '/private/tmp',
        allowProviderFailover: true,
        readOnly: true,
        localNetworkAccess: true,
        queuePriority: 1,
        queueWaitMaxMs: 180_000,
        requiredEvidence: ['diff', 'tests'],
        organizationId: 'org-retry-contract',
        workReportId: 'work-report-retry-contract',
        model: 'retry-model',
        correlationId: 'correlation-retry-attempt',
        turnId: 'turn-retry-attempt',
        attemptId: 'attempt-source',
        idempotencyKey: 'idempotency-source',
        providerRevision: 'sha256:source-revision',
        deadlineAt: '2000-01-01T00:00:00.000Z',
      }),
      'retry-root',
    );

    const retryStartedAt = Date.now();
    const response = await server.inject({
      method: 'POST',
      url: '/api/tasks/retry-attempt/retry',
      payload: { ai: 'ollama', prompt: replacementPrompt },
    });

    expect(response.statusCode).toBe(202);
    const { newTaskId } = response.json() as { newTaskId: string };
    const child = db.prepare(`
      SELECT prompt, system_prompt, assigned_to, workspace_id, priority, verifier_json,
             metadata_json, parent_task_id
      FROM tasks
      WHERE id = ?
    `).get(newTaskId) as {
      prompt: string;
      system_prompt: string | null;
      assigned_to: string | null;
      workspace_id: string | null;
      priority: number;
      verifier_json: string | null;
      metadata_json: string | null;
      parent_task_id: string | null;
    };

    expect(child.prompt).toBe(replacementPrompt);
    expect(child.assigned_to).toBe('ollama');
    expect(child.parent_task_id).toBe('retry-root');
    expect(child.system_prompt).toBe('preserved system prompt');
    expect(child.workspace_id).toBe('retry-workspace');
    expect(child.priority).toBe(8);
    expect(JSON.parse(child.verifier_json ?? 'null')).toEqual(verifier);
    const childMetadata = JSON.parse(child.metadata_json ?? '{}') as Record<string, unknown>;
    expect(childMetadata).toMatchObject({
      projectDir: '/private/tmp',
      allowProviderFailover: true,
      readOnly: true,
      localNetworkAccess: true,
      queuePriority: 1,
      queueWaitMaxMs: 180_000,
      requiredEvidence: ['diff', 'tests'],
      organizationId: 'org-retry-contract',
      workReportId: 'work-report-retry-contract',
      model: 'retry-model',
      correlationId: 'correlation-retry-attempt',
      turnId: 'turn-retry-attempt',
      providerRevision: providerRuntimeCoordinator.getSnapshot()?.revision,
    });
    expect(childMetadata.attemptId).toMatch(/^attempt_[0-9a-f]{24}$/);
    expect(childMetadata.attemptId).not.toBe('attempt-source');
    expect(childMetadata).not.toHaveProperty('idempotencyKey');
    expect(Date.parse(String(childMetadata.deadlineAt))).toBeGreaterThan(retryStartedAt);
  });

  it('uses the internal project directory when the source has none', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (
        id, mode, prompt, assigned_to, status, workspace_id, priority, metadata_json
      ) VALUES (?, 'task', ?, 'codex', 'failed', 'default', 0, ?)
    `).run(
      'retry-without-project',
      [
        '[컨텍스트] retry fallback contract',
        '[목표] preserve the original prompt',
        '[제약] use the internal project directory',
        '[출력형식] plain text',
        '[검증기준] inspect the persisted child task',
      ].join('\n'),
      JSON.stringify({ allowProviderFailover: false }),
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/tasks/retry-without-project/retry',
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    const { newTaskId } = response.json() as { newTaskId: string };
    const child = db.prepare(`
      SELECT metadata_json, parent_task_id
      FROM tasks
      WHERE id = ?
    `).get(newTaskId) as { metadata_json: string | null; parent_task_id: string | null };

    expect(child.parent_task_id).toBe('retry-without-project');
    expect(JSON.parse(child.metadata_json ?? '{}')).toMatchObject({
      projectDir: resolveInternalProjectDir(),
      allowProviderFailover: false,
    });
  });

  it('does not create an automatic quality-retry child after explicit provider failover opt-out', async () => {
    vi.mocked(taskQueue.enqueue).mockResolvedValueOnce({
      success: true,
      output: '<thinking>unfinished internal draft</thinking>',
      status: 'completed',
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        ai: 'codex',
        prompt: 'Return a final verified result for the quality opt-out contract.',
        metadata: {
          projectDir: resolveInternalProjectDir(),
          allowProviderFailover: false,
        },
      },
    });
    expect(response.statusCode).toBe(202);
    const { taskId } = response.json() as { taskId: string };

    await vi.waitFor(() => {
      const row = getDb().prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as
        | { status: string }
        | undefined;
      expect(row?.status).toBe('failed');
    });

    const children = getDb().prepare('SELECT id FROM tasks WHERE parent_task_id=?').all(taskId);
    expect(children).toEqual([]);
  });

  it('applies workflow and quality gates to a task completed by startup recovery', async () => {
    const db = getDb();
    const workflowRunId = createWorkflowRun({
      prompt: 'startup recovery terminal side-effect contract',
      source: 'gateway-retry-test',
      metadata: { workflowIntent: 'routine' },
    }, db);
    db.prepare(`
      INSERT INTO tasks (
        id, mode, prompt, assigned_to, status, response, metadata_json, completed_at
      ) VALUES (?, 'task', ?, 'codex', 'completed', ?, ?, datetime('now'))
    `).run(
      'recovered-quality-reject',
      'Return a final verified result for startup recovery.',
      '<thinking>unfinished internal draft</thinking>',
      JSON.stringify({ allowProviderFailover: false }),
    );
    attachWorkflowTask(
      'recovered-quality-reject',
      workflowRunId,
      'implementation',
      null,
      'codex',
      db,
    );

    await server.settlePersistedTaskTerminal('recovered-quality-reject');

    expect(db.prepare(`
      SELECT status, error FROM tasks WHERE id='recovered-quality-reject'
    `).get()).toEqual({
      status: 'failed',
      error: expect.stringContaining('quality_rejected:'),
    });
    expect(db.prepare(`
      SELECT status, error FROM workflow_stages
      WHERE workflow_run_id=? AND stage='implementation' AND team_id IS NULL
    `).get(workflowRunId)).toEqual({
      status: 'failed',
      error: expect.stringContaining('quality_rejected:'),
    });
    expect(db.prepare(`
      SELECT count(*) AS count FROM tasks WHERE parent_task_id='recovered-quality-reject'
    `).get()).toEqual({ count: 0 });
  });

  it('completes the workflow for a quality-approved startup recovery result', async () => {
    const db = getDb();
    const workflowRunId = createWorkflowRun({
      prompt: 'startup recovery workflow completion contract',
      source: 'gateway-retry-test',
      metadata: { workflowIntent: 'routine' },
    }, db);
    db.prepare(`
      INSERT INTO tasks (
        id, mode, prompt, assigned_to, status, response, evidence_json,
        metadata_json, completed_at
      ) VALUES (?, 'task', ?, 'codex', 'completed', ?, ?, ?, datetime('now'))
    `).run(
      'recovered-quality-pass',
      'Summarize the verified startup recovery result.',
      `done: ${'startup recovery contract verified '.repeat(40)}`,
      JSON.stringify({ source: 'recovery-test' }),
      JSON.stringify({ allowProviderFailover: false }),
    );
    attachWorkflowTask(
      'recovered-quality-pass',
      workflowRunId,
      'implementation',
      null,
      'codex',
      db,
    );

    await server.settlePersistedTaskTerminal('recovered-quality-pass');

    expect(db.prepare(`
      SELECT status, evidence_json FROM workflow_stages
      WHERE workflow_run_id=? AND stage='implementation' AND team_id IS NULL
    `).get(workflowRunId)).toEqual({
      status: 'completed',
      evidence_json: JSON.stringify({ source: 'recovery-test' }),
    });
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(workflowRunId))
      .toEqual({ status: 'completed' });
  });

  it('routes a Conductor team task through quality and organization audit gates', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO organizations (id, name, slug)
      VALUES ('org-conductor-audit', 'Conductor Audit Org', 'conductor-audit-org')
    `).run();
    db.prepare(`
      INSERT INTO teams (id, organization_id, name, slug)
      VALUES (
        'team-conductor-audit',
        'org-conductor-audit',
        'Conductor Audit Team',
        'conductor-audit-team'
      )
    `).run();
    vi.spyOn(smartRouter, 'dispatch').mockResolvedValueOnce({
      mode: 'task',
      providers: ['codex'],
      complexity: 3,
      reasoning: 'test single-provider conductor route',
      tier: 'worker',
    });
    vi.mocked(taskQueue.enqueue).mockResolvedValueOnce({
      success: true,
      output: `done: ${'conductor team result verified '.repeat(40)}`,
      status: 'completed',
      evidenceJson: JSON.stringify({ source: 'conductor-test' }),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{}', { status: 409 }),
    );

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/conductor',
        payload: {
          prompt: 'Summarize the routine team result.',
          metadata: {
            teamId: 'team-conductor-audit',
            workflowIntent: 'routine',
          },
        },
      });
      expect(response.statusCode).toBe(200);
      const { taskId, workflowRunId } = response.json() as {
        taskId: string;
        workflowRunId: string;
      };

      await vi.waitFor(() => {
        const row = db.prepare(`
          SELECT status, completed_at, metadata_json FROM tasks WHERE id=?
        `).get(taskId) as {
          status: string;
          completed_at: string | null;
          metadata_json: string;
        };
        expect(row.status).toBe('reviewing');
        expect(row.completed_at).toBeNull();
        expect(JSON.parse(row.metadata_json)).toMatchObject({
          verificationStatus: 'pending',
          auditPriority: 10,
        });
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(db.prepare(`
        SELECT status FROM workflow_stages
        WHERE workflow_run_id=? AND team_id=? AND stage='implementation'
      `).get(workflowRunId, 'team-conductor-audit')).toEqual({ status: 'running' });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('gates a Conductor discussion synthesis as the audited design artifact', async () => {
    vi.spyOn(smartRouter, 'dispatch').mockResolvedValueOnce({
      mode: 'discussion',
      providers: ['codex', 'ollama'],
      complexity: 7,
      reasoning: 'test multi-provider conductor audit route',
      tier: 'brain',
    });
    vi.spyOn(discussionEngine, 'startDiscussion').mockResolvedValueOnce({
      sessionId: 'discussion-conductor-design-audit',
      topic: 'Produce an audited design.',
      mode: 'discussion',
      participants: ['codex', 'ollama'],
      rounds: [{
        round: 1,
        responses: { codex: 'proposal A', ollama: 'proposal B' },
        consensusRate: 0.9,
      }],
      finalConsensusRate: 0.9,
      adoptedProposal: `done: ${'audited multi-provider design synthesis '.repeat(40)}`,
      rationale: 'Cross-evaluated synthesis selected by consensus.',
      dissentingOpinions: [],
      totalDurationMs: 1_200,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 409 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/conductor',
        payload: {
          prompt: 'Produce a cross-evaluated implementation design.',
          metadata: {
            teamId: 'team-conductor-audit',
            requiredEvidence: ['discussion', 'design'],
          },
        },
      });
      expect(response.statusCode).toBe(200);
      const { taskId, workflowRunId, workflowStage } = response.json() as {
        taskId: string;
        workflowRunId: string;
        workflowStage: string;
      };
      expect(workflowStage).toBe('design');

      await vi.waitFor(() => {
        const row = getDb().prepare(`
          SELECT status, workflow_stage, evidence_json FROM tasks WHERE id=?
        `).get(taskId) as {
          status: string;
          workflow_stage: string;
          evidence_json: string;
        };
        expect(row.status).toBe('reviewing');
        expect(row.workflow_stage).toBe('design');
        expect(JSON.parse(row.evidence_json)).toMatchObject({
          discussion: {
            sessionId: 'discussion-conductor-design-audit',
            participants: ['codex', 'ollama'],
          },
          design: { rationale: 'Cross-evaluated synthesis selected by consensus.' },
        });
      });
      expect(getDb().prepare(`
        SELECT status FROM workflow_stages
        WHERE workflow_run_id=? AND team_id=? AND stage='design'
      `).get(workflowRunId, 'team-conductor-audit')).toEqual({ status: 'running' });

      const approved = await server.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/verification`,
        payload: {
          receiptId: 'receipt-conductor-design-6-of-6',
          actorId: 'nova-ax-auditor',
        },
      });
      expect(approved.statusCode).toBe(200);
      expect(getDb().prepare('SELECT status FROM tasks WHERE id=?').get(taskId))
        .toEqual({ status: 'completed' });
      expect(getDb().prepare(`
        SELECT status FROM workflow_stages
        WHERE workflow_run_id=? AND team_id=? AND stage='design'
      `).get(workflowRunId, 'team-conductor-audit')).toEqual({ status: 'completed' });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('dispatches a Kanban initial attempt through the canonical task intake', async () => {
    vi.mocked(taskQueue.enqueue).mockResolvedValueOnce({
      success: true,
      output: `done: ${'kanban intake contract verified '.repeat(40)}`,
      status: 'completed',
      evidenceJson: JSON.stringify({ tests: 'passed' }),
    });
    const created = await kanbanEngine.createTaskRef?.({
      kanbanTaskId: 'kanban-intake-task',
      planId: 'kanban-intake-plan',
      agentId: 'codex',
      prompt: 'Implement and verify the Kanban canonical intake contract.',
      model: 'kanban-intake-model',
      systemPrompt: 'Use the persisted Kanban execution contract.',
      timeoutMs: 240_000,
      priority: 7,
      verifier: { type: 'run', command: 'true', timeoutMs: 12_000 },
      requiredEvidence: ['tests'],
      metadata: {
        projectDir: '/private/tmp',
        readOnly: true,
      },
    });

    expect(created).toMatchObject({ ok: true });
    const taskId = created?.newTaskId as string;
    await vi.waitFor(() => {
      expect(getDb().prepare('SELECT status FROM tasks WHERE id=?').get(taskId))
        .toEqual({ status: 'completed' });
    });

    const row = getDb().prepare(`
      SELECT assigned_to, priority, system_prompt, verifier_json, metadata_json
      FROM tasks WHERE id=?
    `).get(taskId) as {
      assigned_to: string;
      priority: number;
      system_prompt: string;
      verifier_json: string;
      metadata_json: string;
    };
    expect(row).toMatchObject({
      assigned_to: 'codex',
      priority: 7,
      system_prompt: 'Use the persisted Kanban execution contract.',
    });
    expect(JSON.parse(row.verifier_json)).toEqual({
      type: 'run',
      command: 'true',
      timeoutMs: 12_000,
    });
    expect(JSON.parse(row.metadata_json)).toMatchObject({
      projectDir: '/private/tmp',
      readOnly: true,
      kanbanTaskId: 'kanban-intake-task',
      kanbanPlanId: 'kanban-intake-plan',
      allowProviderFailover: true,
      model: 'kanban-intake-model',
      taskTimeoutMs: 240_000,
      requiredEvidence: ['tests'],
    });
    const enqueueCall = vi.mocked(taskQueue.enqueue).mock.calls
      .find(([input]) => input.taskId === taskId)?.[0];
    expect(enqueueCall).toMatchObject({
      taskId,
      agentId: 'codex',
      model: 'kanban-intake-model',
      timeoutMs: 240_000,
      priority: 7,
      verifier: { type: 'run', command: 'true', timeoutMs: 12_000 },
      metadata: {
        kanbanTaskId: 'kanban-intake-task',
        kanbanPlanId: 'kanban-intake-plan',
      },
    });
  });

  it('projects organization audit waiting and approval back to the linked Kanban plan', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO plans (id, title, markdown_path, status)
      VALUES ('kanban-audit-plan', 'Audit-gated Kanban plan', '/tmp/kanban-audit.md', 'active')
    `).run();
    db.prepare(`
      INSERT INTO kanban_tasks (
        id, plan_id, title, column_status, assigned_to, task_id
      ) VALUES (
        'kanban-audit-card', 'kanban-audit-plan', 'Await organization audit',
        'in_progress', 'codex', 'kanban-audit-task'
      )
    `).run();
    db.prepare(`
      INSERT INTO tasks (
        id, mode, prompt, assigned_to, status, team_id, response, metadata_json
      ) VALUES (?, 'task', ?, 'codex', 'reviewing', ?, ?, ?)
    `).run(
      'kanban-audit-task',
      'Complete the audit-gated Kanban task with sufficient verified detail.',
      'team-conductor-audit',
      `done: ${'audit-ready Kanban result '.repeat(40)}`,
      JSON.stringify({
        kanbanTaskId: 'kanban-audit-card',
        kanbanPlanId: 'kanban-audit-plan',
        verificationStatus: 'pending',
      }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 409 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    try {
      await server.settlePersistedTaskTerminal('kanban-audit-task');
      expect(db.prepare(`
        SELECT column_status FROM kanban_tasks WHERE id='kanban-audit-card'
      `).get()).toEqual({ column_status: 'review' });

      const response = await server.inject({
        method: 'POST',
        url: '/api/tasks/kanban-audit-task/verification',
        payload: {
          receiptId: 'receipt-kanban-audit-6-of-6',
          actorId: 'nova-ax-auditor',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(db.prepare(`
        SELECT column_status FROM kanban_tasks WHERE id='kanban-audit-card'
      `).get()).toEqual({ column_status: 'done' });
      expect(db.prepare(`
        SELECT status FROM plans WHERE id='kanban-audit-plan'
      `).get()).toEqual({ status: 'completed' });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('projects a recovered canonical failure to Kanban review instead of leaving it in progress', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO plans (id, title, markdown_path, status)
      VALUES ('kanban-failure-plan', 'Recovered failure plan', '/tmp/kanban-failure.md', 'active')
    `).run();
    db.prepare(`
      INSERT INTO kanban_tasks (
        id, plan_id, title, column_status, assigned_to, task_id
      ) VALUES (
        'kanban-failure-card', 'kanban-failure-plan', 'Inspect recovered failure',
        'in_progress', 'codex', 'kanban-failure-task'
      )
    `).run();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, error, metadata_json)
      VALUES (?, 'task', ?, 'codex', 'failed', ?, ?)
    `).run(
      'kanban-failure-task',
      'Recover a failed task and surface it for human inspection.',
      'provider exited during restart recovery',
      JSON.stringify({
        kanbanTaskId: 'kanban-failure-card',
        kanbanPlanId: 'kanban-failure-plan',
      }),
    );

    await server.settlePersistedTaskTerminal('kanban-failure-task');

    expect(db.prepare(`
      SELECT column_status, task_id
      FROM kanban_tasks WHERE id='kanban-failure-card'
    `).get()).toEqual({
      column_status: 'review',
      task_id: 'kanban-failure-task',
    });
  });

  it('atomically hands a linked Kanban card to its canonical retry child', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO plans (id, title, markdown_path, status)
      VALUES ('kanban-rebind-plan', 'Retry ownership plan', '/tmp/kanban-rebind.md', 'active')
    `).run();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, metadata_json)
      VALUES (?, 'task', ?, 'codex', 'failed', ?)
    `).run(
      'kanban-rebind-source',
      'Retry this canonical Kanban task.',
      JSON.stringify({
        kanbanTaskId: 'kanban-rebind-card',
        kanbanPlanId: 'kanban-rebind-plan',
        projectDir: '/private/tmp',
      }),
    );
    db.prepare(`
      INSERT INTO kanban_tasks (
        id, plan_id, title, column_status, assigned_to, task_id
      ) VALUES (
        'kanban-rebind-card', 'kanban-rebind-plan', 'Track the current retry attempt',
        'review', 'codex', 'kanban-rebind-source'
      )
    `).run();
    vi.mocked(taskQueue.enqueue).mockImplementationOnce(() => new Promise(() => {}));

    const response = await server.inject({
      method: 'POST',
      url: '/api/tasks/kanban-rebind-source/retry',
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    const { newTaskId } = response.json() as { newTaskId: string };
    expect(db.prepare(`
      SELECT column_status, task_id
      FROM kanban_tasks WHERE id='kanban-rebind-card'
    `).get()).toEqual({
      column_status: 'in_progress',
      task_id: newTaskId,
    });

    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, metadata_json)
      VALUES (?, 'task', ?, 'ollama', 'queued', ?)
    `).run(
      'kanban-stale-retry-child',
      'A late retry must not steal the card from its current child.',
      JSON.stringify({
        kanbanTaskId: 'kanban-rebind-card',
        kanbanPlanId: 'kanban-rebind-plan',
      }),
    );
    expect(kanbanEngine.bindRetryTask(
      'kanban-rebind-source',
      'kanban-stale-retry-child',
    )).toBe(false);
    expect(db.prepare(`
      SELECT column_status, task_id
      FROM kanban_tasks WHERE id='kanban-rebind-card'
    `).get()).toEqual({
      column_status: 'in_progress',
      task_id: newTaskId,
    });
  });

  it('projects the persisted canonical status instead of a mismatched completion hint', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO plans (id, title, markdown_path, status)
      VALUES ('kanban-status-ssot-plan', 'Canonical status SSOT', '/tmp/kanban-status-ssot.md', 'active')
    `).run();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, metadata_json)
      VALUES (?, 'task', ?, 'codex', 'failed', ?)
    `).run(
      'kanban-status-ssot-task',
      'Do not allow a stale hint to complete this task.',
      JSON.stringify({
        kanbanTaskId: 'kanban-status-ssot-card',
        kanbanPlanId: 'kanban-status-ssot-plan',
      }),
    );
    db.prepare(`
      INSERT INTO kanban_tasks (
        id, plan_id, title, column_status, assigned_to, task_id
      ) VALUES (
        'kanban-status-ssot-card', 'kanban-status-ssot-plan', 'Stay in review after failure',
        'in_progress', 'codex', 'kanban-status-ssot-task'
      )
    `).run();

    expect(kanbanEngine.projectTaskStatus(
      'kanban-status-ssot-task',
      'completed',
    )).toBe(true);
    expect(db.prepare(`
      SELECT column_status, task_id
      FROM kanban_tasks WHERE id='kanban-status-ssot-card'
    `).get()).toEqual({
      column_status: 'review',
      task_id: 'kanban-status-ssot-task',
    });
    expect(db.prepare(`
      SELECT status FROM plans WHERE id='kanban-status-ssot-plan'
    `).get()).toEqual({ status: 'active' });
  });

  it('validates Kanban move aliases and plan execution boundaries', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO plans (id, title, markdown_path, status)
      VALUES ('kanban-api-plan', 'Kanban API boundaries', '/tmp/kanban-api.md', 'draft')
    `).run();
    db.prepare(`
      INSERT INTO kanban_tasks (id, plan_id, title, column_status)
      VALUES ('kanban-api-card', 'kanban-api-plan', 'Validate move aliases', 'todo')
    `).run();

    const compatibleMove = await server.inject({
      method: 'POST',
      url: '/api/kanban/move',
      payload: { taskId: 'kanban-api-card', toColumn: 'review' },
    });
    expect(compatibleMove.statusCode).toBe(200);
    expect(compatibleMove.json()).toEqual({ moved: true });
    expect(db.prepare(`
      SELECT column_status FROM kanban_tasks WHERE id='kanban-api-card'
    `).get()).toEqual({ column_status: 'review' });

    const completeMove = await server.inject({
      method: 'POST',
      url: '/api/kanban/move',
      payload: { taskId: 'kanban-api-card', to: 'done' },
    });
    expect(completeMove.statusCode).toBe(200);
    expect(db.prepare(`
      SELECT status FROM plans WHERE id='kanban-api-plan'
    `).get()).toEqual({ status: 'completed' });

    const reopenMove = await server.inject({
      method: 'POST',
      url: '/api/kanban/move',
      payload: { taskId: 'kanban-api-card', to: 'review' },
    });
    expect(reopenMove.statusCode).toBe(200);
    expect(db.prepare(`
      SELECT status FROM plans WHERE id='kanban-api-plan'
    `).get()).toEqual({ status: 'active' });

    db.prepare(`
      INSERT INTO plans (id, title, markdown_path, status)
      VALUES ('kanban-linked-plan', 'Canonical task guard', '/tmp/kanban-linked.md', 'active')
    `).run();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES ('kanban-linked-reviewing', 'task', 'Await audit', 'codex', 'reviewing')
    `).run();
    db.prepare(`
      INSERT INTO kanban_tasks (id, plan_id, title, column_status, task_id)
      VALUES (
        'kanban-linked-card', 'kanban-linked-plan', 'Do not false-complete',
        'review', 'kanban-linked-reviewing'
      )
    `).run();
    const guardedDone = await server.inject({
      method: 'POST',
      url: '/api/kanban/move',
      payload: { taskId: 'kanban-linked-card', to: 'done' },
    });
    expect(guardedDone.statusCode).toBe(409);
    expect(guardedDone.json()).toMatchObject({
      error: 'canonical_task_not_completed',
      taskId: 'kanban-linked-card',
      canonicalTaskId: 'kanban-linked-reviewing',
      canonicalStatus: 'reviewing',
    });
    expect(db.prepare(`
      SELECT column_status FROM kanban_tasks WHERE id='kanban-linked-card'
    `).get()).toEqual({ column_status: 'review' });
    expect(db.prepare(`
      SELECT status FROM plans WHERE id='kanban-linked-plan'
    `).get()).toEqual({ status: 'active' });

    const invalidMove = await server.inject({
      method: 'POST',
      url: '/api/kanban/move',
      payload: { taskId: 'kanban-api-card', to: 'sideways' },
    });
    expect(invalidMove.statusCode).toBe(400);
    expect(invalidMove.json()).toMatchObject({ error: 'invalid_kanban_move' });

    const missingCard = await server.inject({
      method: 'POST',
      url: '/api/kanban/move',
      payload: { taskId: 'missing-kanban-card', to: 'todo' },
    });
    expect(missingCard.statusCode).toBe(404);
    expect(missingCard.json()).toMatchObject({ error: 'kanban_task_not_found' });

    const invalidStrategy = await server.inject({
      method: 'POST',
      url: '/api/plan/execute',
      payload: { planId: 'kanban-api-plan', strategy: 'eventually' },
    });
    expect(invalidStrategy.statusCode).toBe(400);
    expect(invalidStrategy.json()).toMatchObject({ error: 'invalid_plan_execution' });

    const missingPlan = await server.inject({
      method: 'POST',
      url: '/api/plan/execute',
      payload: { planId: 'missing-kanban-plan', strategy: 'auto' },
    });
    expect(missingPlan.statusCode).toBe(404);
    expect(missingPlan.json()).toMatchObject({ error: 'plan_not_found' });
  });

  it('validates plan creation and refuses destructive markdown sync while a card is active', async () => {
    const invalidCreate = await server.inject({
      method: 'POST',
      url: '/api/plan/create',
      payload: { title: 'Invalid tasks shape', tasks: 'not-an-array' },
    });
    expect(invalidCreate.statusCode).toBe(400);
    expect(invalidCreate.json()).toMatchObject({ error: 'invalid_plan' });

    const emptyTaskTitle = await server.inject({
      method: 'POST',
      url: '/api/plan/create',
      payload: { title: 'Reject empty task title', tasks: ['P1: (codex)'] },
    });
    expect(emptyTaskTitle.statusCode).toBe(400);
    expect(emptyTaskTitle.json()).toMatchObject({
      error: 'invalid_plan_task',
      issues: [{
        index: 0,
        label: 'P1: (codex)',
        reason: 'title_required',
      }],
    });

    const missingPlan = await server.inject({
      method: 'POST',
      url: '/api/plan/missing-sync-plan/sync',
    });
    expect(missingPlan.statusCode).toBe(404);
    expect(missingPlan.json()).toMatchObject({
      error: 'plan_not_found',
      planId: 'missing-sync-plan',
    });

    const db = getDb();
    const markdownPath = resolve(testDir!, 'active-plan-sync.md');
    writeFileSync(markdownPath, '# Active plan\n\n- [x] P1: Preserve active card (ollama)\n', 'utf-8');
    db.prepare(`
      INSERT INTO plans (id, title, markdown_path, status)
      VALUES ('active-sync-plan', 'Active sync guard', ?, 'active')
    `).run(markdownPath);
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES ('active-sync-task', 'task', 'Do not sever this link', 'codex', 'running')
    `).run();
    db.prepare(`
      INSERT INTO kanban_tasks (
        id, plan_id, title, column_status, assigned_to, task_id
      ) VALUES (
        'active-sync-card', 'active-sync-plan', 'Preserve active card',
        'in_progress', 'codex', 'active-sync-task'
      )
    `).run();

    const refused = await server.inject({
      method: 'POST',
      url: '/api/plan/active-sync-plan/sync',
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: 'plan_has_active_tasks',
      conflicts: [{
        kanbanTaskId: 'active-sync-card',
        canonicalTaskId: 'active-sync-task',
        kanbanStatus: 'in_progress',
        canonicalStatus: 'running',
      }],
    });
    expect(db.prepare(`
      SELECT id, title, column_status, task_id
      FROM kanban_tasks WHERE id='active-sync-card'
    `).get()).toEqual({
      id: 'active-sync-card',
      title: 'Preserve active card',
      column_status: 'in_progress',
      task_id: 'active-sync-task',
    });

    db.prepare("UPDATE tasks SET status='completed' WHERE id='active-sync-task'").run();
    db.prepare("UPDATE kanban_tasks SET column_status='done' WHERE id='active-sync-card'").run();
    const reconciled = await server.inject({
      method: 'POST',
      url: '/api/plan/active-sync-plan/sync',
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toEqual({ synced: 1 });
    expect(db.prepare(`
      SELECT id, title, column_status, assigned_to, task_id, execution_type
      FROM kanban_tasks WHERE plan_id='active-sync-plan'
    `).get()).toEqual({
      id: 'active-sync-card',
      title: 'Preserve active card',
      column_status: 'done',
      assigned_to: 'ollama',
      task_id: 'active-sync-task',
      execution_type: 'parallel',
    });
    expect(readFileSync(markdownPath, 'utf-8')).toContain('- [x] P1: Preserve active card (ollama)');
    expect(db.prepare(`
      SELECT status FROM plans WHERE id='active-sync-plan'
    `).get()).toEqual({ status: 'completed' });

    const roundTripped = await server.inject({
      method: 'POST',
      url: '/api/plan/active-sync-plan/sync',
    });
    expect(roundTripped.statusCode).toBe(200);
    expect(db.prepare(`
      SELECT execution_type
      FROM kanban_tasks WHERE id='active-sync-card'
    `).get()).toEqual({ execution_type: 'parallel' });

    writeFileSync(markdownPath, '# Active plan\n\n- [ ] P1: Preserve active card (ollama)\n', 'utf-8');
    const reopened = await server.inject({
      method: 'POST',
      url: '/api/plan/active-sync-plan/sync',
    });
    expect(reopened.statusCode).toBe(200);
    expect(db.prepare(`
      SELECT status FROM plans WHERE id='active-sync-plan'
    `).get()).toEqual({ status: 'active' });

    writeFileSync(markdownPath, '# Active plan\n\n- [x] P1: Preserve active card (ollama)\n', 'utf-8');
    const reclosed = await server.inject({
      method: 'POST',
      url: '/api/plan/active-sync-plan/sync',
    });
    expect(reclosed.statusCode).toBe(200);
    expect(db.prepare(`
      SELECT status FROM plans WHERE id='active-sync-plan'
    `).get()).toEqual({ status: 'completed' });

    writeFileSync(markdownPath, '# Active plan\n\n- [ ] P1: (codex)\n', 'utf-8');
    const invalidMarkdownTask = await server.inject({
      method: 'POST',
      url: '/api/plan/active-sync-plan/sync',
    });
    expect(invalidMarkdownTask.statusCode).toBe(400);
    expect(invalidMarkdownTask.json()).toMatchObject({
      error: 'invalid_plan_task',
      issues: [{ line: 3, reason: 'title_required' }],
    });
    expect(db.prepare(`
      SELECT title, column_status, task_id
      FROM kanban_tasks WHERE id='active-sync-card'
    `).get()).toEqual({
      title: 'Preserve active card',
      column_status: 'done',
      task_id: 'active-sync-task',
    });

    db.prepare("UPDATE tasks SET status='failed' WHERE id='active-sync-task'").run();
    db.prepare("UPDATE kanban_tasks SET column_status='todo' WHERE id='active-sync-card'").run();
    writeFileSync(markdownPath, '# Active plan\n\n- [x] Preserve active card (ollama)\n', 'utf-8');
    const prematureDone = await server.inject({
      method: 'POST',
      url: '/api/plan/active-sync-plan/sync',
    });
    expect(prematureDone.statusCode).toBe(409);
    expect(prematureDone.json()).toMatchObject({
      error: 'canonical_task_not_completed',
      conflicts: [{
        kanbanTaskId: 'active-sync-card',
        canonicalTaskId: 'active-sync-task',
        kanbanStatus: 'todo',
        canonicalStatus: 'failed',
      }],
    });
    expect(db.prepare(`
      SELECT column_status, assigned_to, task_id
      FROM kanban_tasks WHERE id='active-sync-card'
    `).get()).toEqual({
      column_status: 'todo',
      assigned_to: 'ollama',
      task_id: 'active-sync-task',
    });

    const placeholderPath = resolve(testDir!, 'placeholder-plan-sync.md');
    writeFileSync(placeholderPath, '# Empty plan\n\n- [ ] (작업 추가 필요)\n', 'utf-8');
    db.prepare(`
      INSERT INTO plans (id, title, markdown_path, status)
      VALUES ('placeholder-sync-plan', 'Empty placeholder plan', ?, 'draft')
    `).run(placeholderPath);
    const placeholderSync = await server.inject({
      method: 'POST',
      url: '/api/plan/placeholder-sync-plan/sync',
    });
    expect(placeholderSync.statusCode).toBe(200);
    expect(placeholderSync.json()).toEqual({ synced: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM kanban_tasks WHERE plan_id='placeholder-sync-plan'
    `).get()).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT status FROM plans WHERE id='placeholder-sync-plan'
    `).get()).toEqual({ status: 'draft' });
  });

  it('routes compatibility Kanban mutations through canonical task safety contracts', async () => {
    const db = getDb();
    vi.mocked(taskQueue.enqueue).mockResolvedValueOnce({
      success: true,
      output: `done: ${'compatibility intake used the canonical queue '.repeat(40)}`,
      status: 'completed',
    });

    const created = await server.inject({
      method: 'POST',
      url: '/api/kanban/tasks',
      payload: {
        title: 'Queue this compatibility task canonically.',
        assignedTo: 'codex',
        workspace: 'compat-workspace',
        priority: 6,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const createdTask = (created.json() as { task: { id: string } }).task;
    expect(vi.mocked(taskQueue.enqueue).mock.calls.some(([input]) => (
      input.taskId === createdTask.id
      && input.agentId === 'codex'
      && input.priority === 6
    ))).toBe(true);

    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES ('compat-cancel-task', 'task', 'cancel through canonical route', 'codex', 'pending')
    `).run();
    const cancelled = await server.inject({
      method: 'PATCH',
      url: '/api/kanban/tasks/compat-cancel-task',
      payload: { status: 'cancelled' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect((cancelled.json() as { task: { status: string } }).task.status).toBe('cancelled');

    const purged = await server.inject({
      method: 'DELETE',
      url: '/api/kanban/tasks/compat-cancel-task',
    });
    expect(purged.statusCode).toBe(200);
    expect(purged.json()).toMatchObject({
      ok: true,
      purgedStatus: 'cancelled',
    });
    expect(db.prepare(`
      SELECT id FROM tasks WHERE id='compat-cancel-task'
    `).get()).toBeUndefined();

    db.prepare(`
      INSERT INTO plans (id, title, markdown_path, status)
      VALUES ('compat-detach-plan', 'Detach purged attempt', '/tmp/compat-detach.md', 'completed')
    `).run();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES ('compat-linked-failure', 'task', 'detach this failed attempt', 'codex', 'failed')
    `).run();
    db.prepare(`
      INSERT INTO kanban_tasks (id, plan_id, title, column_status, assigned_to, task_id)
      VALUES (
        'compat-linked-card', 'compat-detach-plan', 'Preserve the plan card',
        'review', 'codex', 'compat-linked-failure'
      )
    `).run();
    const detached = await server.inject({
      method: 'DELETE',
      url: '/api/kanban/tasks/compat-linked-failure',
    });
    expect(detached.statusCode).toBe(200);
    expect(detached.json()).toMatchObject({
      ok: true,
      detachedKanbanCards: 1,
    });
    expect(db.prepare(`
      SELECT task_id, column_status
      FROM kanban_tasks WHERE id='compat-linked-card'
    `).get()).toEqual({ task_id: null, column_status: 'todo' });
    expect(db.prepare(`
      SELECT status FROM plans WHERE id='compat-detach-plan'
    `).get()).toEqual({ status: 'active' });

    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES ('compat-completed-task', 'task', 'retain completed evidence', 'codex', 'completed')
    `).run();
    const refusedPurge = await server.inject({
      method: 'DELETE',
      url: '/api/kanban/tasks/compat-completed-task',
    });
    expect(refusedPurge.statusCode).toBe(409);
    expect(refusedPurge.json()).toMatchObject({
      error: 'task_must_be_cancelled_or_failed_before_purge',
      status: 'completed',
    });

    const refusedCompletionPatch = await server.inject({
      method: 'PATCH',
      url: '/api/kanban/tasks/compat-completed-task',
      payload: { status: 'completed' },
    });
    expect(refusedCompletionPatch.statusCode).toBe(400);
    expect(refusedCompletionPatch.json()).toMatchObject({
      error: 'invalid_kanban_task_patch',
    });
  });

  it('persists and enqueues one canonical execution contract for restart recovery', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        ai: 'codex',
        model: 'recovery-contract-model',
        prompt: 'persist canonical restart recovery execution contract',
        priority: 8,
        timeout: 240_000,
        metadata: {
          projectDir: '/private/tmp',
          readOnly: true,
          localNetworkAccess: false,
          queuePriority: 2,
        },
      },
    });

    expect(response.statusCode).toBe(202);
    const { taskId } = response.json() as { taskId: string };
    const enqueueCall = vi.mocked(taskQueue.enqueue).mock.calls
      .find(([queued]) => queued.taskId === taskId)?.[0];
    expect(enqueueCall).toMatchObject({
      taskId,
      agentId: 'codex',
      model: 'recovery-contract-model',
      priority: 8,
      timeoutMs: 240_000,
      metadata: {
        projectDir: '/private/tmp',
        readOnly: true,
        localNetworkAccess: false,
        queuePriority: 2,
        taskTimeoutMs: 240_000,
        model: 'recovery-contract-model',
        requestedProvider: 'codex',
      },
    });
    expect(typeof enqueueCall?.metadata?.invocationId).toBe('string');

    const row = getDb().prepare('SELECT priority, metadata_json FROM tasks WHERE id=?')
      .get(taskId) as { priority: number; metadata_json: string };
    expect(row.priority).toBe(8);
    expect(JSON.parse(row.metadata_json)).toMatchObject({
      projectDir: '/private/tmp',
      taskTimeoutMs: 240_000,
      model: 'recovery-contract-model',
      requestedProvider: 'codex',
      invocationId: enqueueCall?.metadata?.invocationId,
    });
  });

  it('retries a lease-expired terminal task through the same canonical contract', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, priority)
      VALUES (?, 'task', ?, 'codex', 'lease_expired', 7)
    `).run('retry-lease-expired', 'lease-expired retry contract');

    const response = await server.inject({
      method: 'POST',
      url: '/api/tasks/retry-lease-expired/retry',
      payload: { ai: 'ollama' },
    });

    expect(response.statusCode).toBe(202);
    const { newTaskId } = response.json() as { newTaskId: string };
    expect(db.prepare(`
      SELECT assigned_to, priority, parent_task_id FROM tasks WHERE id=?
    `).get(newTaskId)).toEqual({
      assigned_to: 'ollama',
      priority: 7,
      parent_task_id: 'retry-lease-expired',
    });
  });

  it('inherits workflow and audit input contracts without copying prior result flags', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, metadata_json)
      VALUES (?, 'task', ?, 'codex', 'failed', ?)
    `).run(
      'retry-metadata-contract',
      'metadata contract prompt',
      JSON.stringify({
        projectDir: '/private/tmp',
        workflowRunId: 'workflow-retry-contract',
        workflowStage: 'implementation',
        workflowRequired: true,
        qualityRetryOwner: 'company-orchestrator',
        auditControlPlane: true,
        verificationDirectiveId: 'directive-retry-contract',
        subjectId: 'subject-retry-contract',
        subjectKind: 'task',
        kanbanTaskId: 'kanban-retry-card',
        kanbanPlanId: 'kanban-retry-plan',
        taskTimeoutMs: 240_000,
        correlationId: 'correlation-retry-contract',
        turnId: 'turn-retry-contract',
        attemptId: 'attempt-old',
        idempotencyKey: 'idempotency-old',
        providerRevision: 'sha256:old-provider-revision',
        deadlineAt: '2000-01-01T00:00:00.000Z',
        qualityRejected: true,
        qualityHeuristics: ['old-result'],
        verificationStatus: 'approved',
        verificationReceiptId: 'old-receipt',
        attemptedAgents: ['codex'],
      }),
    );

    const payload = loadRetryPayload(db, 'retry-metadata-contract');
    expect(payload?.metadata).toMatchObject({
      projectDir: '/private/tmp',
      workflowRunId: 'workflow-retry-contract',
      workflowStage: 'implementation',
      workflowRequired: true,
      qualityRetryOwner: 'company-orchestrator',
      auditControlPlane: true,
      verificationDirectiveId: 'directive-retry-contract',
      subjectId: 'subject-retry-contract',
      subjectKind: 'task',
      kanbanTaskId: 'kanban-retry-card',
      kanbanPlanId: 'kanban-retry-plan',
      taskTimeoutMs: 240_000,
      correlationId: 'correlation-retry-contract',
      turnId: 'turn-retry-contract',
    });
    expect(payload?.metadata).not.toHaveProperty('attemptId');
    expect(payload?.metadata).not.toHaveProperty('idempotencyKey');
    expect(payload?.metadata).not.toHaveProperty('providerRevision');
    expect(payload?.metadata).not.toHaveProperty('deadlineAt');
    expect(payload?.metadata).not.toHaveProperty('qualityRejected');
    expect(payload?.metadata).not.toHaveProperty('qualityHeuristics');
    expect(payload?.metadata).not.toHaveProperty('verificationStatus');
    expect(payload?.metadata).not.toHaveProperty('verificationReceiptId');
    expect(payload?.metadata).not.toHaveProperty('attemptedAgents');
    expect(payload?.timeout).toBe(240_000);
  });

  it('collapses a legacy nested retry chain onto the oldest existing root', async () => {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, parent_task_id)
      VALUES (?, 'task', ?, 'codex', 'failed', ?)
    `);
    insert.run('legacy-retry-root', 'root prompt', null);
    insert.run('legacy-retry-child', 'child prompt', 'legacy-retry-root');
    insert.run('legacy-retry-grandchild', 'grandchild prompt', 'legacy-retry-child');

    const response = await server.inject({
      method: 'POST',
      url: '/api/tasks/legacy-retry-grandchild/retry',
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    const { newTaskId } = response.json() as { newTaskId: string };
    const created = db.prepare('SELECT parent_task_id FROM tasks WHERE id=?')
      .get(newTaskId) as { parent_task_id: string | null };
    expect(created.parent_task_id).toBe('legacy-retry-root');
  });

  it('detects an active retry anywhere in a legacy nested lineage', async () => {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, parent_task_id)
      VALUES (?, 'task', ?, ?, ?, ?)
    `);
    insert.run('legacy-active-root', 'root prompt', 'codex', 'failed', null);
    insert.run('legacy-active-middle', 'middle revised prompt', 'ollama', 'failed', 'legacy-active-root');
    insert.run('legacy-active-grandchild', 'different active prompt', 'codex', 'running', 'legacy-active-middle');

    const response = await server.inject({
      method: 'POST',
      url: '/api/tasks/legacy-active-middle/retry',
      payload: { ai: 'ollama', prompt: 'new revised prompt' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'retry_in_progress_conflict',
      activeRetryTaskId: 'legacy-active-grandchild',
      activeRetryStatus: 'running',
    });
    expect(db.prepare(`
      SELECT count(*) AS count
      FROM tasks
      WHERE id LIKE 'legacy-active-%'
    `).get()).toEqual({ count: 3 });
    expect(db.prepare(`
      SELECT count(*) AS count FROM retry_counts WHERE task_id='legacy-active-root'
    `).get()).toEqual({ count: 0 });
  });

  it('returns an active work-report sibling without consuming retry budget', async () => {
    const db = getDb();
    const metadata = JSON.stringify({
      projectDir: '/private/tmp',
      workReportId: 'work-report-dedup-contract',
    });
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, metadata_json)
      VALUES (?, 'task', ?, 'codex', ?, ?)
    `).run('retry-work-report-source', 'failed report prompt', 'failed', metadata);
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, metadata_json)
      VALUES (?, 'task', ?, 'codex', ?, ?)
    `).run('retry-work-report-active', 'active report prompt', 'running', metadata);

    const response = await server.inject({
      method: 'POST',
      url: '/api/tasks/retry-work-report-source/retry',
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      newTaskId: 'retry-work-report-active',
      retryOf: 'retry-work-report-source',
      deduplicated: true,
    });
    const budget = db.prepare('SELECT count, total_count FROM retry_counts WHERE task_id=?')
      .get('retry-work-report-source') as { count: number; total_count: number } | undefined;
    expect(budget).toEqual({ count: 0, total_count: 0 });
  });

  it('replaces an active stalled task while preserving its execution and workflow contract', async () => {
    const db = getDb();
    const prompt = [
      '[컨텍스트] active retry contract',
      '[목표] replace the stalled worker without closing the workflow',
      '[제약] preserve verifier and execution metadata',
      '[출력형식] plain text',
      '[검증기준] inspect the source, child, and workflow stage',
    ].join('\n');
    const workflowRunId = createWorkflowRun({
      prompt,
      source: 'gateway-retry-test',
      metadata: { workflowIntent: 'routine' },
    }, db);
    const verifier = { type: 'run', command: 'true', timeoutMs: 12_000 } as const;
    db.prepare(`
      INSERT INTO tasks (
        id, mode, prompt, system_prompt, assigned_to, status, workspace_id,
        priority, verifier_json, metadata_json
      ) VALUES (?, 'task', ?, ?, 'codex', 'assigned', ?, ?, ?, ?)
    `).run(
      'retry-active-source',
      prompt,
      'active retry system prompt',
      'active-retry-workspace',
      9,
      JSON.stringify(verifier),
      JSON.stringify({
        projectDir: '/private/tmp',
        workflowRunId,
        workflowStage: 'implementation',
        workflowRequired: false,
        readOnly: true,
        queuePriority: 2,
      }),
    );
    attachWorkflowTask('retry-active-source', workflowRunId, 'implementation', null, 'codex', db);
    vi.spyOn(taskQueue, 'abort').mockResolvedValueOnce(false);

    const response = await server.inject({
      method: 'POST',
      url: '/api/tasks/retry-active-source/retry',
      payload: { ai: 'ollama', replaceActive: true },
    });

    expect(response.statusCode).toBe(202);
    const { newTaskId } = response.json() as { newTaskId: string; replacedActive: boolean };
    expect(response.json()).toMatchObject({
      retryOf: 'retry-active-source',
      replacedActive: true,
    });
    expect(db.prepare('SELECT status, error FROM tasks WHERE id=?').get('retry-active-source'))
      .toEqual({
        status: 'failed',
        error: 'replaced by explicit active-task recovery retry',
      });
    const child = db.prepare(`
      SELECT assigned_to, system_prompt, workspace_id, priority, verifier_json,
             metadata_json, parent_task_id, workflow_run_id, workflow_stage
      FROM tasks WHERE id=?
    `).get(newTaskId) as {
      assigned_to: string;
      system_prompt: string;
      workspace_id: string;
      priority: number;
      verifier_json: string;
      metadata_json: string;
      parent_task_id: string;
      workflow_run_id: string;
      workflow_stage: string;
    };
    expect(child).toMatchObject({
      assigned_to: 'ollama',
      system_prompt: 'active retry system prompt',
      workspace_id: 'active-retry-workspace',
      priority: 9,
      parent_task_id: 'retry-active-source',
      workflow_run_id: workflowRunId,
      workflow_stage: 'implementation',
    });
    expect(JSON.parse(child.verifier_json)).toEqual(verifier);
    expect(JSON.parse(child.metadata_json)).toMatchObject({
      projectDir: '/private/tmp',
      workflowRunId,
      workflowStage: 'implementation',
      workflowRequired: false,
      readOnly: true,
      queuePriority: 2,
    });
    expect(db.prepare(`
      SELECT task_id, status FROM workflow_stages
      WHERE workflow_run_id=? AND stage='implementation' AND team_id IS NULL
    `).get(workflowRunId)).toMatchObject({ task_id: newTaskId });
  });

  it('replaces a pending dashboard task before any worker has claimed it', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES (?, 'task', ?, 'codex', 'pending')
    `).run('retry-pending-source', 'pending active replacement contract');
    vi.spyOn(taskQueue, 'abort').mockResolvedValueOnce(false);

    const response = await server.inject({
      method: 'POST',
      url: '/api/tasks/retry-pending-source/retry',
      payload: { ai: 'ollama', replaceActive: true },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ replacedActive: true });
    const { newTaskId } = response.json() as { newTaskId: string };
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get('retry-pending-source'))
      .toEqual({ status: 'failed' });
    expect(db.prepare('SELECT assigned_to, parent_task_id FROM tasks WHERE id=?').get(newTaskId))
      .toEqual({ assigned_to: 'ollama', parent_task_id: 'retry-pending-source' });
  });

  it('does not terminalize an active source when replacement preflight is rejected', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES (?, 'task', ?, 'codex', 'running')
    `).run('retry-active-invalid-provider', 'active invalid provider preflight');

    const response = await server.inject({
      method: 'POST',
      url: '/api/tasks/retry-active-invalid-provider/retry',
      payload: { ai: 'missing-provider', replaceActive: true },
    });

    expect(response.statusCode).toBe(400);
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get('retry-active-invalid-provider'))
      .toEqual({ status: 'running' });
    expect(db.prepare('SELECT count(*) AS count FROM retry_counts WHERE task_id=?')
      .get('retry-active-invalid-provider')).toEqual({ count: 0 });
  });

  it('rolls back the reserved budget and leaves a retryable failure if worker abort throws', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES (?, 'task', ?, 'codex', 'assigned')
    `).run('retry-active-abort-error', 'active abort error contract');
    vi.spyOn(taskQueue, 'abort').mockRejectedValueOnce(new Error('abort transport failed'));

    const response = await server.inject({
      method: 'POST',
      url: '/api/tasks/retry-active-abort-error/retry',
      payload: { replaceActive: true },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ sourceStatus: 'failed', retryable: true });
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get('retry-active-abort-error'))
      .toEqual({ status: 'failed' });
    expect(db.prepare('SELECT count, total_count FROM retry_counts WHERE task_id=?')
      .get('retry-active-abort-error')).toEqual({ count: 0, total_count: 0 });
  });

  it('deduplicates concurrent active replacement requests onto one retry child', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES (?, 'task', ?, 'codex', 'assigned')
    `).run('retry-active-concurrent', 'concurrent active replacement contract');
    vi.spyOn(taskQueue, 'abort').mockResolvedValueOnce(false);

    const responses = await Promise.all([
      server.inject({
        method: 'POST',
        url: '/api/tasks/retry-active-concurrent/retry',
        payload: { ai: 'ollama', replaceActive: true },
      }),
      server.inject({
        method: 'POST',
        url: '/api/tasks/retry-active-concurrent/retry',
        payload: { ai: 'ollama', replaceActive: true },
      }),
    ]);

    expect(responses.map(response => response.statusCode)).toEqual([202, 202]);
    const bodies = responses.map(response => response.json()) as Array<{
      newTaskId: string;
      replacedActive?: boolean;
      deduplicated?: boolean;
    }>;
    expect(new Set(bodies.map(body => body.newTaskId)).size).toBe(1);
    expect(bodies.every(body => body.replacedActive === true)).toBe(true);
    expect(bodies.filter(body => body.deduplicated === true)).toHaveLength(1);
    expect(db.prepare(`
      SELECT count(*) AS count
      FROM tasks
      WHERE parent_task_id='retry-active-concurrent'
        AND status IN ('queued', 'assigned', 'running', 'streaming', 'reviewing', 'completed')
    `).get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT count, total_count FROM retry_counts WHERE task_id=?')
      .get('retry-active-concurrent')).toEqual({ count: 1, total_count: 1 });
  });

  it('reuses a just-completed child when the canonical prompt and provider are unchanged', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES (?, 'task', ?, 'codex', 'failed')
    `).run('retry-retransmit-source', 'same retransmitted prompt');

    const first = await server.inject({
      method: 'POST',
      url: '/api/tasks/retry-retransmit-source/retry',
      payload: {},
    });
    expect(first.statusCode).toBe(202);
    const firstTaskId = (first.json() as { newTaskId: string }).newTaskId;
    db.prepare(`
      UPDATE tasks
      SET status='completed', completed_at=datetime('now'), updated_at=datetime('now')
      WHERE id=?
    `).run(firstTaskId);

    const retransmitted = await server.inject({
      method: 'POST',
      url: '/api/tasks/retry-retransmit-source/retry',
      payload: {},
    });

    expect(retransmitted.statusCode).toBe(202);
    expect(retransmitted.json()).toMatchObject({
      newTaskId: firstTaskId,
      deduplicated: true,
    });
    expect(db.prepare(`
      SELECT count(*) AS count FROM tasks WHERE parent_task_id='retry-retransmit-source'
    `).get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT count, total_count FROM retry_counts WHERE task_id=?')
      .get('retry-retransmit-source')).toEqual({ count: 1, total_count: 1 });
  });

  it('rejects a changed prompt or provider while a different retry child is active', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES (?, 'task', ?, 'codex', 'failed')
    `).run('retry-active-conflict-source', 'original conflict prompt');

    const first = await server.inject({
      method: 'POST',
      url: '/api/tasks/retry-active-conflict-source/retry',
      payload: {},
    });
    expect(first.statusCode).toBe(202);
    const firstTaskId = (first.json() as { newTaskId: string }).newTaskId;
    db.prepare(`
      UPDATE tasks
      SET status='assigned', completed_at=NULL, updated_at=datetime('now')
      WHERE id=?
    `).run(firstTaskId);

    const changed = await server.inject({
      method: 'POST',
      url: '/api/tasks/retry-active-conflict-source/retry',
      payload: { ai: 'ollama', prompt: 'revised conflict prompt' },
    });

    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({
      error: 'retry_in_progress_conflict',
      activeRetryTaskId: firstTaskId,
    });
    expect(db.prepare(`
      SELECT count(*) AS count FROM tasks WHERE parent_task_id='retry-active-conflict-source'
    `).get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT count, total_count FROM retry_counts WHERE task_id=?')
      .get('retry-active-conflict-source')).toEqual({ count: 1, total_count: 1 });
  });

  it('deduplicates by requested provider when intake failover changed the assigned provider', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES (?, 'task', ?, 'codex', 'failed')
    `).run('retry-provider-failover-source', 'provider failover prompt');

    const first = await server.inject({
      method: 'POST',
      url: '/api/tasks/retry-provider-failover-source/retry',
      payload: {},
    });
    expect(first.statusCode).toBe(202);
    const firstTaskId = (first.json() as { newTaskId: string }).newTaskId;
    db.prepare(`
      UPDATE tasks
      SET assigned_to='ollama', status='assigned', completed_at=NULL, updated_at=datetime('now')
      WHERE id=?
    `).run(firstTaskId);

    const retransmitted = await server.inject({
      method: 'POST',
      url: '/api/tasks/retry-provider-failover-source/retry',
      payload: {},
    });

    expect(retransmitted.statusCode).toBe(202);
    expect(retransmitted.json()).toMatchObject({
      newTaskId: firstTaskId,
      deduplicated: true,
    });
    expect(db.prepare(`
      SELECT count(*) AS count FROM tasks WHERE parent_task_id='retry-provider-failover-source'
    `).get()).toEqual({ count: 1 });
  });

  it('does not reuse a completed child for a later revised prompt or provider', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES (?, 'task', ?, 'codex', 'failed')
    `).run('retry-revised-source', 'original retry prompt');
    db.prepare(`
      INSERT INTO tasks (
        id, mode, prompt, assigned_to, status, parent_task_id, created_at, completed_at
      ) VALUES (?, 'task', ?, 'codex', 'completed', ?, datetime('now'), datetime('now'))
    `).run('retry-revised-completed', 'original retry prompt', 'retry-revised-source');

    const response = await server.inject({
      method: 'POST',
      url: '/api/tasks/retry-revised-source/retry',
      payload: { ai: 'ollama', prompt: 'revised retry prompt' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).not.toHaveProperty('deduplicated');
    const { newTaskId } = response.json() as { newTaskId: string };
    expect(newTaskId).not.toBe('retry-revised-completed');
    const child = db.prepare('SELECT prompt, assigned_to FROM tasks WHERE id=?').get(newTaskId) as {
      prompt: string;
      assigned_to: string;
    };
    expect(child.assigned_to).toBe('ollama');
    expect(child.prompt).toContain('revised retry prompt');
  });

  it('does not reuse an old completed child even when prompt and provider are unchanged', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES (?, 'task', ?, 'codex', 'failed')
    `).run('retry-old-source', 'same retry prompt');
    db.prepare(`
      INSERT INTO tasks (
        id, mode, prompt, assigned_to, status, parent_task_id, created_at, completed_at
      ) VALUES (?, 'task', ?, 'codex', 'completed', ?, datetime('now', '-2 minutes'), datetime('now', '-2 minutes'))
    `).run('retry-old-completed', 'same retry prompt', 'retry-old-source');

    const response = await server.inject({
      method: 'POST',
      url: '/api/tasks/retry-old-source/retry',
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).not.toHaveProperty('deduplicated');
    expect((response.json() as { newTaskId: string }).newTaskId).not.toBe('retry-old-completed');
  });
});

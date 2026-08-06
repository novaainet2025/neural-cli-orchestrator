import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { agentManager } from '../agent/agent-manager.js';
import { acquisitionRegistry } from '../core/acquisition-registry.js';
import { dynamicSkillEngine } from '../core/dynamic-skill-engine.js';
import { discussionEngine } from '../core/discussion-engine.js';
import { resolveExecutionProvider } from '../core/provider-registry.js';
import { taskQueue } from '../core/task-queue.js';
import { closeDb, getDb, runMigrations } from '../storage/database.js';
import {
  createGateway,
  createRoutingCapacityReader,
  resolveBackgroundQueueHighWater,
} from './gateway.js';

vi.mock('../core/provider-qualification.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/provider-qualification.js')>();
  return {
    ...actual,
    isProviderQualified: () => true,
    isProviderModelQualified: () => true,
  };
});

describe.sequential('gateway active rate-limit admission', () => {
  const circuitOrgId = 'org-team-circuit-admission-test';
  const circuitTeamId = 'team-team-circuit-admission-test';
  const originalDatabasePath = process.env.DATABASE_PATH;
  const originalRoutingCapacityTtl = process.env.NCO_ROUTING_CAPACITY_TTL_MS;
  const originalRoutingCapacityNegativeTtl = process.env.NCO_ROUTING_CAPACITY_NEGATIVE_TTL_MS;
  const originalBackgroundQueueHighWater = process.env.NCO_BACKGROUND_QUEUE_HIGH_WATER;
  const originalBackgroundQueueRetryAfter = process.env.NCO_BACKGROUND_QUEUE_RETRY_AFTER_SEC;
  let testDir: string;
  let server: Awaited<ReturnType<typeof createGateway>>;
  let enqueue: ReturnType<typeof vi.spyOn>;
  let getMetrics: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    closeDb();
    testDir = mkdtempSync(resolve(tmpdir(), 'nco-rate-limit-admission-'));
    process.env.DATABASE_PATH = resolve(testDir, 'rate-limit-admission.db');
    // Keep route cases independent while retaining in-flight single-flight.
    process.env.NCO_ROUTING_CAPACITY_TTL_MS = '0';
    process.env.NCO_ROUTING_CAPACITY_NEGATIVE_TTL_MS = '0';
    process.env.NCO_BACKGROUND_QUEUE_HIGH_WATER = '2';
    process.env.NCO_BACKGROUND_QUEUE_RETRY_AFTER_SEC = '17';
    runMigrations();
    await agentManager.init();
    enqueue = vi.spyOn(taskQueue, 'enqueue').mockResolvedValue({
      success: true,
      output: 'done: safely routed',
      status: 'completed',
    });
    getMetrics = vi.spyOn(taskQueue, 'getAdmissionMetrics').mockResolvedValue([]);
    server = await createGateway();
  });

  afterEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM rate_limit_state').run();
    db.prepare('DELETE FROM tasks WHERE team_id=?').run(circuitTeamId);
    db.prepare('DELETE FROM circuit_states WHERE agent_id=?').run(`team:${circuitTeamId}`);
    db.prepare('DELETE FROM teams WHERE id=?').run(circuitTeamId);
    db.prepare('DELETE FROM organizations WHERE id=?').run(circuitOrgId);
    enqueue.mockClear();
    getMetrics.mockReset();
    getMetrics.mockResolvedValue([]);
  });

  afterAll(async () => {
    try {
      await server?.close();
    } finally {
      agentManager.destroy();
      closeDb();
      rmSync(testDir, { recursive: true, force: true });
      if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = originalDatabasePath;
      if (originalRoutingCapacityTtl === undefined) delete process.env.NCO_ROUTING_CAPACITY_TTL_MS;
      else process.env.NCO_ROUTING_CAPACITY_TTL_MS = originalRoutingCapacityTtl;
      if (originalRoutingCapacityNegativeTtl === undefined) delete process.env.NCO_ROUTING_CAPACITY_NEGATIVE_TTL_MS;
      else process.env.NCO_ROUTING_CAPACITY_NEGATIVE_TTL_MS = originalRoutingCapacityNegativeTtl;
      if (originalBackgroundQueueHighWater === undefined) delete process.env.NCO_BACKGROUND_QUEUE_HIGH_WATER;
      else process.env.NCO_BACKGROUND_QUEUE_HIGH_WATER = originalBackgroundQueueHighWater;
      if (originalBackgroundQueueRetryAfter === undefined) delete process.env.NCO_BACKGROUND_QUEUE_RETRY_AFTER_SEC;
      else process.env.NCO_BACKGROUND_QUEUE_RETRY_AFTER_SEC = originalBackgroundQueueRetryAfter;
      vi.restoreAllMocks();
    }
  });

  function limitCursor(): void {
    limitProvider('cursor-agent');
  }

  function limitProvider(agentId: string): void {
    getDb().prepare(`
      INSERT INTO rate_limit_state (agent_id, is_limited, reset_at, updated_at)
      VALUES (?, 1, datetime('now', '+1 hour'), datetime('now'))
      ON CONFLICT(agent_id) DO UPDATE SET
        is_limited=1,
        reset_at=datetime('now', '+1 hour'),
        updated_at=datetime('now')
    `).run(agentId);
  }

  function setCursorIsoReset(resetAt: string): void {
    getDb().prepare(`
      INSERT INTO rate_limit_state (agent_id, is_limited, reset_at, updated_at)
      VALUES ('cursor-agent', 1, ?, datetime('now'))
      ON CONFLICT(agent_id) DO UPDATE SET
        is_limited=1,
        reset_at=excluded.reset_at,
        updated_at=datetime('now')
    `).run(resetAt);
  }

  function queueMetrics(activeByProvider: Record<string, number>, concurrency = 1) {
    return agentManager.listEnabledIds().map(agentId => ({
      agentId,
      waiting: 0,
      active: activeByProvider[agentId] ?? 0,
      completed: 0,
      failed: 0,
      concurrency,
      mode: 'semaphore' as const,
    }));
  }

  it('scales the background ceiling down with currently admitted capacity', () => {
    const metrics = queueMetrics({}, 2);
    expect(resolveBackgroundQueueHighWater(40, metrics, ['codex', 'ollama'], 2)).toBe(8);
    expect(resolveBackgroundQueueHighWater(6, metrics, ['codex', 'ollama'], 2)).toBe(6);
    expect(resolveBackgroundQueueHighWater(40, metrics, [], 2)).toBe(1);
    expect(resolveBackgroundQueueHighWater(0, metrics, ['codex'], 2)).toBe(0);
  });

  it('rejects new team intake while its quality circuit is open', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO organizations (id, name, slug)
      VALUES (?, 'Team Circuit Admission Org', 'team-circuit-admission-org')
    `).run(circuitOrgId);
    db.prepare(`
      INSERT INTO teams (id, organization_id, name, slug)
      VALUES (?, ?, 'Team Circuit Admission', 'team-circuit-admission')
    `).run(circuitTeamId, circuitOrgId);
    db.prepare(`
      INSERT INTO circuit_states (
        agent_id, state, failure_count, opened_at, cooldown_until, reason,
        last_evaluated_task_rowid
      ) VALUES (?, 'open', 2, ?, ?, 'team-failure:quality regression', 0)
    `).run(`team:${circuitTeamId}`, Date.now(), Date.now() + 60_000);

    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        ai: 'codex',
        prompt: 'Do not enqueue while this team circuit is open.',
        metadata: {
          projectDir: tmpdir(),
          teamId: circuitTeamId,
          workflowIntent: 'routine',
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'team_circuit_open',
      teamId: circuitTeamId,
      retryable: true,
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE team_id=?')
      .get(circuitTeamId)).toEqual({ count: 0 });
  });

  it('rejects conductor intake before routing while its team circuit is open', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO circuit_states (
        agent_id, state, failure_count, opened_at, cooldown_until, reason,
        last_evaluated_task_rowid
      ) VALUES (?, 'open', 2, ?, ?, 'team-failure:quality regression', 0)
    `).run(`team:${circuitTeamId}`, Date.now(), Date.now() + 60_000);

    const response = await server.inject({
      method: 'POST',
      url: '/api/conductor',
      payload: {
        prompt: 'Route this request.',
        metadata: { teamId: circuitTeamId },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'team_circuit_open',
      teamId: circuitTeamId,
      retryable: true,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('cleans an expired team circuit at intake and does not reuse its old failures', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO organizations (id, name, slug)
      VALUES (?, 'Team Circuit Admission Org', 'team-circuit-admission-org')
    `).run(circuitOrgId);
    db.prepare(`
      INSERT INTO teams (id, organization_id, name, slug)
      VALUES (?, ?, 'Team Circuit Admission', 'team-circuit-admission')
    `).run(circuitTeamId, circuitOrgId);
    const insertFailure = db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, team_id, error)
      VALUES (?, 'task', 'historical quality failure', 'codex', 'failed', ?, 'quality regression')
    `);
    insertFailure.run('task-team-circuit-old-1', circuitTeamId);
    insertFailure.run('task-team-circuit-old-2', circuitTeamId);
    const latestOldRowId = (db.prepare(`
      SELECT MAX(rowid) AS rowid FROM tasks WHERE team_id=?
    `).get(circuitTeamId) as { rowid: number }).rowid;
    db.prepare(`
      INSERT INTO circuit_states (
        agent_id, state, failure_count, opened_at, cooldown_until, reason,
        last_evaluated_task_rowid
      ) VALUES (?, 'open', 2, ?, ?, 'team-failure:quality regression', NULL)
    `).run(`team:${circuitTeamId}`, Date.now() - 120_000, Date.now() - 1);

    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        ai: 'codex',
        prompt: 'Return one short status line.',
        metadata: {
          projectDir: tmpdir(),
          teamId: circuitTeamId,
          workflowIntent: 'routine',
        },
      },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(db.prepare(`
      SELECT state, failure_count, opened_at, cooldown_until, reason,
             last_evaluated_task_rowid
      FROM circuit_states WHERE agent_id=?
    `).get(`team:${circuitTeamId}`)).toEqual({
      state: 'closed',
      failure_count: 0,
      opened_at: null,
      cooldown_until: null,
      reason: null,
      last_evaluated_task_rowid: latestOldRowId,
    });
  });

  it('rejects an explicitly requested limited provider before enqueue', async () => {
    limitCursor();

    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        ai: 'cursor-agent',
        prompt: 'Return one short status line.',
        metadata: { projectDir: tmpdir() },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'provider_gated',
      requestedProvider: 'cursor-agent',
      gate: { status: 'gated:rate-limit', reason: 'rate-limit' },
    });
    expect(response.json().availableProviders).not.toContain('cursor-agent');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('uses the requested Hive quorum when realtime discussion excludes a limited provider', async () => {
    const providers = agentManager.listEnabledIds().slice(0, 3);
    expect(providers).toHaveLength(3);
    limitProvider(providers[2]!);
    const startDiscussion = vi.spyOn(discussionEngine, 'startDiscussion')
      .mockImplementation(() => new Promise(() => {}));

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/realtime/discussion',
        payload: {
          prompt: 'Complete with the two admitted Hive providers.',
          mode: 'hive',
          providers,
          projectDir: testDir,
        },
      });

      expect(response.statusCode, response.body).toBe(202);
      expect(response.json()).toMatchObject({
        mode: 'hive',
        providers: providers.slice(0, 2),
      });
      expect(startDiscussion).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'hive',
        providers: providers.slice(0, 2),
      }));
    } finally {
      startDiscussion.mockRestore();
    }
  });

  it('keeps explicit chat/session intent pinned and returns the existing provider_gated body', async () => {
    limitCursor();
    const executeTask = vi.spyOn(agentManager, 'executeTask');
    const { sessionManager } = await import('../agent/session-manager.js');
    const startSession = vi.spyOn(sessionManager, 'startSession');

    try {
      const chatResponse = await server.inject({
        method: 'POST',
        url: '/api/chat/messages',
        payload: {
          ai: 'cursor-agent',
          prompt: 'Do not execute this limited provider.',
          projectDir: tmpdir(),
        },
      });

      expect(chatResponse.statusCode).toBe(409);
      expect(chatResponse.json()).toMatchObject({
        error: 'provider_gated',
        requestedProvider: 'cursor-agent',
        gate: { status: 'gated:rate-limit', reason: 'rate-limit' },
      });
      const sessionResponse = await server.inject({
        method: 'POST',
        url: '/api/agent/start',
        payload: {
          provider: 'cursor-agent',
          prompt: 'Do not execute this limited provider.',
        },
      });
      expect(sessionResponse.statusCode).toBe(409);
      expect(sessionResponse.json()).toMatchObject({
        error: 'provider_gated',
        requestedProvider: 'cursor-agent',
        gate: { status: 'gated:rate-limit', reason: 'rate-limit' },
      });
      expect(executeTask).not.toHaveBeenCalled();
      expect(startSession).not.toHaveBeenCalled();
    } finally {
      executeTask.mockRestore();
      startSession.mockRestore();
    }
  });

  it('routes omitted chat and session requests around the limited catalog default', async () => {
    const limitedDefault = resolveExecutionProvider(undefined, 'general');
    const expectedProvider = resolveExecutionProvider(undefined, 'general', {
      isAvailable: agentId => agentId !== limitedDefault,
    });
    limitProvider(limitedDefault);
    const executeTask = vi.spyOn(agentManager, 'executeTask').mockResolvedValue(
      {
        taskId: 'chat-auto-route',
        agentId: expectedProvider,
        output: 'routed',
        iterations: 1,
        toolCalls: 0,
        success: true,
        durationMs: 1,
      },
    );
    const { sessionManager } = await import('../agent/session-manager.js');
    const startSession = vi.spyOn(sessionManager, 'startSession').mockResolvedValue('session-auto-route');

    try {
      const chatResponse = await server.inject({
        method: 'POST',
        url: '/api/chat/messages',
        payload: {
          prompt: 'Select a live chat provider.',
          projectDir: tmpdir(),
        },
      });
      expect(chatResponse.statusCode, chatResponse.body).toBe(202);
      expect(chatResponse.json()).toMatchObject({ agentId: expectedProvider });

      const sessionResponse = await server.inject({
        method: 'POST',
        url: '/api/agent/start',
        payload: { prompt: 'Select a live session provider.' },
      });
      expect(sessionResponse.statusCode, sessionResponse.body).toBe(200);
      expect(sessionResponse.json()).toMatchObject({
        sessionId: 'session-auto-route',
        agentId: expectedProvider,
      });
      expect(executeTask).toHaveBeenCalledWith(
        expectedProvider,
        'Select a live chat provider.',
        expect.any(Object),
      );
      expect(startSession).toHaveBeenCalledWith(
        'Select a live session provider.',
        expectedProvider,
        expect.any(Object),
      );
      expect(executeTask).not.toHaveBeenCalledWith(
        limitedDefault,
        expect.anything(),
        expect.anything(),
      );
      expect(startSession).not.toHaveBeenCalledWith(
        expect.anything(),
        limitedDefault,
        expect.anything(),
      );
    } finally {
      executeTask.mockRestore();
      startSession.mockRestore();
    }
  });

  it('passes durable runtime admission into dynamic MCP skill execution', async () => {
    limitCursor();
    const healthyProvider = resolveExecutionProvider(undefined, 'general', {
      isAvailable: agentId => agentId !== 'cursor-agent',
    });
    const listSkills = vi.spyOn(acquisitionRegistry, 'listAcquiredSkillNames').mockReturnValue([{
      id: 'skill-runtime-admission',
      name: 'acquired_runtime_admission',
      description: 'Runtime admission test',
    }]);
    const executeSkill = vi.spyOn(dynamicSkillEngine, 'executeSkill').mockImplementation(
      async (_skillId, _prompt, _executor, options) => {
        expect(await options?.isAvailable?.('cursor-agent')).toBe(false);
        expect(await options?.isAvailable?.(healthyProvider)).toBe(true);
        return { output: 'admission checked', quality: 100, steps: 1 };
      },
    );

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/mcp/dynamic-tools/execute',
        payload: {
          name: 'acquired_runtime_admission',
          prompt: 'Use only a live provider.',
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ output: 'admission checked', steps: 1 });
      expect(executeSkill).toHaveBeenCalledOnce();
    } finally {
      listSkills.mockRestore();
      executeSkill.mockRestore();
    }
  });

  it('uses only a non-limited alternative when cross-role failover is authorized', async () => {
    limitCursor();

    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        ai: 'cursor-agent',
        prompt: 'Return one short status line.',
        metadata: {
          projectDir: tmpdir(),
          allowProviderFailover: true,
        },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().agentId).not.toBe('cursor-agent');
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      agentId: expect.not.stringMatching(/^cursor-agent$/),
    }));
  });

  it('persists automatic model provenance for queue failover and recovery', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        ai: 'codex',
        prompt: 'Return one short implementation status line.',
        metadata: { projectDir: tmpdir() },
      },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      metadata: expect.objectContaining({
        modelSelection: 'task-type',
        modelTaskType: 'code',
        modelResolvedProvider: 'codex',
      }),
    }));
  });

  it('rejects a future ISO Z reset before enqueue', async () => {
    setCursorIsoReset(new Date(Date.now() + 60_000).toISOString());

    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        ai: 'cursor-agent',
        prompt: 'Do not enqueue while the ISO reset is in the future.',
        metadata: { projectDir: tmpdir() },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'provider_gated',
      gate: { status: 'gated:rate-limit' },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('treats an expired ISO Z reset as available', async () => {
    setCursorIsoReset(new Date(Date.now() - 60_000).toISOString());

    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        ai: 'cursor-agent',
        prompt: 'Enqueue after the ISO reset has expired.',
        metadata: { projectDir: tmpdir() },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ agentId: 'cursor-agent' });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'cursor-agent',
    }));
  });

  it('exposes the common DB admission decision for out-of-process provider I/O', async () => {
    getDb().prepare(`
      INSERT INTO rate_limit_state (agent_id, is_limited, reset_at, updated_at)
      VALUES ('ollama', 1, datetime('now', '+1 hour'), datetime('now'))
      ON CONFLICT(agent_id) DO UPDATE SET
        is_limited=1,
        reset_at=datetime('now', '+1 hour'),
        updated_at=datetime('now')
    `).run();

    const response = await server.inject({
      method: 'GET',
      url: '/api/rate-limits/admission/ollama',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      allowed: false,
      status: 'active-rate-limit',
    });
  });

  it('routes a saturated requested provider to a free same-role provider when failover is allowed', async () => {
    const originalGetProvider = agentManager.getProvider.bind(agentManager);
    const providerLookup = vi.spyOn(agentManager, 'getProvider').mockImplementation(agentId => {
      const provider = originalGetProvider(agentId);
      if (!provider) return provider;
      return agentId === 'cursor-agent' || agentId === 'codex'
        ? { ...provider, role: 'Reviewer' }
        : provider;
    });
    getMetrics.mockResolvedValue(queueMetrics({ 'cursor-agent': 1 }));

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/task',
        payload: {
          ai: 'cursor-agent',
          prompt: 'Route this review to an available review lane.',
          metadata: { projectDir: tmpdir(), allowProviderFailover: true },
        },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        agentId: 'codex',
        failover: { reason: 'same-role-capacity', freeSlots: 1 },
      });
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'codex',
        metadata: expect.objectContaining({
          providerRouting: expect.objectContaining({
            reason: 'same-role-capacity',
            freeSlots: 1,
          }),
        }),
      }));
    } finally {
      providerLookup.mockRestore();
    }
  });

  it('keeps deterministic automatic routing when every provider is saturated', async () => {
    getMetrics.mockResolvedValue(queueMetrics(
      Object.fromEntries(agentManager.listEnabledIds().map(id => [id, 1])),
    ));

    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        prompt: 'Queue this automatic task deterministically.',
        metadata: { projectDir: tmpdir() },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ agentId: 'claude-code' });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'claude-code',
      metadata: expect.objectContaining({
        providerRouting: {
          kind: 'fallback',
          reason: 'all-candidates-saturated',
          freeSlots: 0,
        },
      }),
    }));
  });

  it('returns retryable 429 before persisting or enqueueing saturated audit control-plane work', async () => {
    getMetrics.mockResolvedValue(queueMetrics({ codex: 1 }).map(metric => (
      metric.agentId === 'codex' ? { ...metric, waiting: 1 } : metric
    )));

    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        ai: 'codex',
        prompt: 'Run a background completion audit after capacity returns.',
        metadata: {
          projectDir: tmpdir(),
          auditControlPlane: true,
        },
      },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('17');
    expect(response.json()).toMatchObject({
      error: 'background_queue_backpressure',
      code: 'NCO_BACKGROUND_QUEUE_HIGH_WATER',
      retryable: true,
      infrastructureFailure: true,
      retryAfter: 17,
      queue: { waiting: 1, active: 1, outstanding: 2, highWater: 2 },
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(getDb().prepare(`
      SELECT COUNT(*) AS count FROM tasks WHERE prompt LIKE '%background completion audit%'
    `).get()).toEqual({ count: 0 });
  });

  it('applies the same high-water gate to performance assignment dispatches', async () => {
    getMetrics.mockResolvedValue(queueMetrics({ codex: 2 }));

    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        ai: 'codex',
        prompt: 'Prepare the scheduled performance assignment.',
        metadata: {
          projectDir: tmpdir(),
          performanceAssignmentId: 'assignment-1',
        },
      },
    });

    expect(response.statusCode).toBe(429);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('applies the same high-water gate to work-report scheduler dispatches', async () => {
    getMetrics.mockResolvedValue(queueMetrics({ codex: 2 }));

    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        ai: 'codex',
        prompt: 'Prepare the scheduled team work report.',
        metadata: {
          projectDir: tmpdir(),
          workReportId: 'wr-high-water-1',
        },
      },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      code: 'NCO_BACKGROUND_QUEUE_HIGH_WATER',
      queue: { outstanding: 2, highWater: 2 },
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(getDb().prepare(`
      SELECT COUNT(*) AS count FROM tasks WHERE prompt LIKE '%scheduled team work report%'
    `).get()).toEqual({ count: 0 });
  });

  it('keeps interactive intake available above the background high-water mark', async () => {
    getMetrics.mockResolvedValue(queueMetrics({ codex: 2 }));

    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        prompt: 'Handle this interactive user request now.',
        metadata: { projectDir: tmpdir() },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('returns retryable 503 before persisting background work when live queue telemetry fails', async () => {
    getMetrics.mockRejectedValueOnce(new Error('queue metrics unavailable'));

    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        ai: 'codex',
        prompt: 'Retry background intake after queue telemetry recovers.',
        metadata: {
          projectDir: tmpdir(),
          auditControlPlane: true,
        },
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('17');
    expect(response.json()).toMatchObject({
      error: 'background_queue_telemetry_unavailable',
      code: 'NCO_BACKGROUND_QUEUE_TELEMETRY_UNAVAILABLE',
      retryable: true,
      infrastructureFailure: true,
      retryAfter: 17,
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(getDb().prepare(`
      SELECT COUNT(*) AS count FROM tasks WHERE prompt LIKE '%Retry background intake%'
    `).get()).toEqual({ count: 0 });
  });

  it('fails closed when the live admission snapshot omits one provider', async () => {
    getMetrics.mockResolvedValueOnce(queueMetrics({}).slice(1));

    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        ai: 'codex',
        prompt: 'Retry partial-snapshot background intake later.',
        metadata: {
          projectDir: tmpdir(),
          auditControlPlane: true,
        },
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: 'NCO_BACKGROUND_QUEUE_TELEMETRY_UNAVAILABLE',
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('keeps deterministic automatic routing when queue metrics fail', async () => {
    getMetrics.mockRejectedValueOnce(new Error('queue metrics unavailable'));

    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        prompt: 'Queue this task despite missing capacity telemetry.',
        metadata: { projectDir: tmpdir() },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ agentId: 'claude-code' });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'claude-code',
      metadata: expect.objectContaining({
        providerRouting: {
          kind: 'fallback',
          reason: 'queue-metrics-unavailable',
          freeSlots: null,
        },
      }),
    }));
  });

  it('bounds a stalled metrics read and falls back without rejecting intake', async () => {
    let releaseMetrics!: (metrics: ReturnType<typeof queueMetrics>) => void;
    getMetrics.mockImplementationOnce(() => new Promise(resolveMetrics => {
      releaseMetrics = resolveMetrics;
    }));
    const startedAt = Date.now();

    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        prompt: 'Queue this task after the capacity deadline.',
        metadata: { projectDir: tmpdir() },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'claude-code',
      metadata: expect.objectContaining({
        providerRouting: expect.objectContaining({
          reason: 'queue-metrics-unavailable',
          freeSlots: null,
        }),
      }),
    }));
    releaseMetrics(queueMetrics({}));
    await new Promise(resolveImmediate => setImmediate(resolveImmediate));
  });

  it('does not inspect capacity for an explicit provider with failover disabled', async () => {
    getMetrics.mockResolvedValue(queueMetrics({ 'cursor-agent': 1 }));

    const response = await server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        ai: 'cursor-agent',
        prompt: 'Keep this task on the explicitly requested queue.',
        metadata: { projectDir: tmpdir(), allowProviderFailover: false },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ agentId: 'cursor-agent' });
    expect(getMetrics).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'cursor-agent' }));
  });

  it('shares one capacity metrics read across concurrent automatic intake', async () => {
    let releaseMetrics!: (metrics: ReturnType<typeof queueMetrics>) => void;
    getMetrics.mockImplementationOnce(() => new Promise(resolve => {
      releaseMetrics = resolve;
    }));

    const first = server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        prompt: 'First concurrent automatic intake.',
        metadata: { projectDir: tmpdir() },
      },
    });
    const second = server.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        prompt: 'Second concurrent automatic intake.',
        metadata: { projectDir: tmpdir() },
      },
    });

    await vi.waitFor(() => expect(getMetrics).toHaveBeenCalledTimes(1));
    releaseMetrics(queueMetrics({}));
    const responses = await Promise.all([first, second]);

    expect(responses.map(response => response.statusCode)).toEqual([202, 202]);
    expect(getMetrics).toHaveBeenCalledTimes(1);
  });

  it('keeps one stalled source read across bursts and repeated negative-TTL expiry', async () => {
    let clock = 0;
    const readLive = vi.fn(() => new Promise<ReturnType<typeof queueMetrics>>(() => {}));
    const readCapacity = createRoutingCapacityReader({
      readLive,
      isComplete: () => true,
      successTtlMs: 0,
      negativeTtlMs: 1_000,
      deadlineMs: 25,
      now: () => clock,
    });

    const first = await readCapacity();
    const repeated = await Promise.all(Array.from({ length: 9 }, () => readCapacity()));
    const afterExpiry = [];
    for (let expiry = 0; expiry < 3; expiry++) {
      clock += 1_001;
      afterExpiry.push(await readCapacity());
    }

    expect(first).toEqual({ metrics: [], available: false });
    expect(repeated.every(snapshot => snapshot.available === false)).toBe(true);
    expect(afterExpiry.every(snapshot => snapshot.available === false)).toBe(true);
    expect(readLive).toHaveBeenCalledTimes(1);
  });
});

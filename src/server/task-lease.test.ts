import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { closeDb, getDb, runMigrations } from '../storage/database.js';
import { createGateway } from './gateway.js';
import { env } from '../utils/config.js';
import { persistTaskReassignment } from '../core/task-queue.js';

describe.sequential('task lease routes', () => {
  const testDbPath = resolve(env.ROOT, 'db/test-task-lease.db');
  let server: Awaited<ReturnType<typeof createGateway>>;

  beforeAll(async () => {
    closeDb();
    process.env.DATABASE_PATH = testDbPath;
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    runMigrations();
    server = await createGateway();
  });

  afterAll(async () => {
    await server.close();
    closeDb();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    delete process.env.DATABASE_PATH;
  });

  it('acks and heartbeats an assigned task', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES (?, 'task', ?, ?, 'assigned')
    `).run('route-task-1', 'prompt', 'codex');

    const ackResponse = await server.inject({
      method: 'POST',
      url: '/api/task/route-task-1/ack',
    });
    expect(ackResponse.statusCode).toBe(200);
    const ackBody = ackResponse.json() as {
      ok: boolean;
      task: { acked_at: string | null; lease_expires_at: string | null };
    };
    expect(ackBody.ok).toBe(true);
    expect(ackBody.task.acked_at).toBeTruthy();
    expect(ackBody.task.lease_expires_at).toBeTruthy();

    const heartbeatResponse = await server.inject({
      method: 'POST',
      url: '/api/task/route-task-1/heartbeat',
      payload: { progress: { step: 2, total: 5 }, note: 'working' },
    });
    expect(heartbeatResponse.statusCode).toBe(200);
    const heartbeatBody = heartbeatResponse.json() as {
      ok: boolean;
      task: { heartbeat_seq: number | null; last_heartbeat_at: string | null };
    };
    expect(heartbeatBody.ok).toBe(true);
    expect(heartbeatBody.task.heartbeat_seq).toBe(1);
    expect(heartbeatBody.task.last_heartbeat_at).toBeTruthy();

    const taskResponse = await server.inject({
      method: 'GET',
      url: '/api/task/route-task-1',
    });
    expect(taskResponse.statusCode).toBe(200);
    const taskBody = taskResponse.json() as {
      task: {
        acked_at: string | null;
        last_heartbeat_at: string | null;
        heartbeat_seq: number | null;
        lease_expires_at: string | null;
        progress: number | null;
      };
    };
    expect(taskBody.task.acked_at).toBeTruthy();
    expect(taskBody.task.last_heartbeat_at).toBeTruthy();
    expect(taskBody.task.heartbeat_seq).toBe(1);
    expect(taskBody.task.lease_expires_at).toBeTruthy();
    expect(taskBody.task.progress).toBeCloseTo(0.4);
  });

  it('returns 409 heartbeat conflict for completed tasks', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES (?, 'task', ?, ?, 'completed')
    `).run('route-task-2', 'prompt', 'codex');

    const response = await server.inject({
      method: 'POST',
      url: '/api/task/route-task-2/heartbeat',
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'heartbeat_conflict',
      status: 'completed',
    });
  });

  it('exposes a provider mismatch when the actual executor differs from the requested provider', async () => {
    getDb().prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, metadata_json)
      VALUES (?, 'task', ?, ?, 'completed', ?)
    `).run('route-task-provider-mismatch', 'prompt', 'ollama', JSON.stringify({ requestedProvider: 'codex' }));

    const response = await server.inject({
      method: 'GET',
      url: '/api/task/route-task-provider-mismatch',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().task).toMatchObject({
      assigned_to: 'ollama',
      requestedProvider: 'codex',
      providerMismatch: true,
    });
  });

  it('projects active discussion round, response count, and liveness onto task status routes', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, progress)
      VALUES (?, 'discussion', ?, ?, 'assigned', 0)
    `).run('route-task-discussion-progress', 'compare implementations', 'opencode');
    db.prepare(`
      INSERT INTO discussions (
        id, topic, mode, status, participants_json, initiator, current_round,
        max_rounds, task_id
      ) VALUES (?, ?, 'discussion', 'active', ?, 'claude-code', 0, 3, ?)
    `).run(
      'discussion-progress-route',
      'compare implementations',
      JSON.stringify(['opencode', 'agy', 'cursor-agent']),
      'route-task-discussion-progress',
    );
    db.prepare(`
      INSERT INTO discussion_messages (
        id, discussion_id, agent_id, round, message_type, content
      ) VALUES (?, ?, 'opencode', 1, 'proposal', 'proposal complete')
    `).run('discussion-progress-message', 'discussion-progress-route');

    const statusResponse = await server.inject({
      method: 'GET',
      url: '/api/tasks/route-task-discussion-progress/status',
    });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json()).toMatchObject({
      status: 'running',
      progress: 11,
      currentStep: '토론 1/3 · 응답 1/3 수집',
      liveness: 'working',
    });

    const taskResponse = await server.inject({
      method: 'GET',
      url: '/api/task/route-task-discussion-progress',
    });
    expect(taskResponse.statusCode).toBe(200);
    expect(taskResponse.json().task).toMatchObject({
      status: 'running',
      progress: 11,
      currentStep: '토론 1/3 · 응답 1/3 수집',
      liveness: 'working',
    });
  });

  it('keeps a terminal task authoritative over a late active discussion row', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, progress)
      VALUES (?, 'discussion', ?, ?, 'cancelled', 0)
    `).run('route-task-cancelled-discussion', 'cancelled prompt', 'codex');
    db.prepare(`
      INSERT INTO discussions (
        id, topic, mode, status, participants_json, initiator, current_round,
        max_rounds, task_id
      ) VALUES (?, ?, 'discussion', 'active', ?, 'codex', 1, 3, ?)
    `).run(
      'late-active-discussion',
      'cancelled prompt',
      JSON.stringify(['codex', 'agy']),
      'route-task-cancelled-discussion',
    );

    const [taskResponse, statusResponse] = await Promise.all([
      server.inject({ method: 'GET', url: '/api/tasks/route-task-cancelled-discussion' }),
      server.inject({ method: 'GET', url: '/api/tasks/route-task-cancelled-discussion/status' }),
    ]);

    expect(taskResponse.json().task).toMatchObject({
      status: 'cancelled',
      liveness: 'failed',
      currentStep: '작업 실패',
    });
    expect(statusResponse.json()).toMatchObject({
      status: 'cancelled',
      liveness: 'failed',
      currentStep: '작업 실패',
    });
  });

  it('records runtime provider reassignment in task metadata and decision log', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, metadata_json)
      VALUES (?, 'task', ?, ?, 'assigned', ?)
    `).run('route-task-reassignment', 'prompt', 'codex', JSON.stringify({ requestedProvider: 'codex' }));

    persistTaskReassignment(
      'route-task-reassignment',
      'codex',
      'ollama',
      { attemptedAgents: ['codex', 'ollama'] },
    );

    const task = db.prepare('SELECT assigned_to, metadata_json FROM tasks WHERE id = ?')
      .get('route-task-reassignment') as { assigned_to: string; metadata_json: string };
    const decision = db.prepare('SELECT decision FROM decision_log WHERE task_id = ?')
      .get('route-task-reassignment') as { decision: string };

    expect(task.assigned_to).toBe('ollama');
    expect(JSON.parse(task.metadata_json)).toMatchObject({ reassignedFrom: 'codex' });
    expect(decision.decision).toBe('reassign:codex->ollama');
  });
});

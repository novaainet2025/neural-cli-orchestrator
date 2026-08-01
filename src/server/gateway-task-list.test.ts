import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { agentManager } from '../agent/agent-manager.js';
import { closeDb, getDb, runMigrations } from '../storage/database.js';
import { createGateway } from './gateway.js';

describe.sequential('gateway task list pagination and filtering', () => {
  const originalDatabasePath = process.env.DATABASE_PATH;
  let testDir: string | undefined;
  let testDbPath: string | undefined;
  let server: Awaited<ReturnType<typeof createGateway>>;

  beforeAll(async () => {
    closeDb();
    testDir = mkdtempSync(resolve(tmpdir(), 'nco-gateway-task-list-'));
    testDbPath = resolve(testDir, 'gateway-task-list.db');
    process.env.DATABASE_PATH = testDbPath;
    runMigrations();
    await agentManager.init();
    server = await createGateway();
  });

  afterAll(async () => {
    try {
      if (server) await server.close();
    } finally {
      agentManager.destroy();
      closeDb();
      if (testDir) rmSync(testDir, { recursive: true, force: true });
      if (originalDatabasePath === undefined) {
        delete process.env.DATABASE_PATH;
      } else {
        process.env.DATABASE_PATH = originalDatabasePath;
      }
      vi.restoreAllMocks();
    }
  });

  it('proves stable non-overlapping filtered pages, total/hasMore/statusCounts, and combined filters', async () => {
    const db = getDb();

    // Create test tasks
    const insertStmt = db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, workspace_id, created_at, updated_at)
      VALUES (?, 'task', ?, ?, ?, ?, ?, ?)
    `);

    // We'll create tasks with specific timings to test stable created_at + rowid DESC sorting
    const baseTime = 1600000000000;

    for (let i = 1; i <= 5; i++) {
      // Same timestamp for all to prove rowid tie-breaker
      const createdAt = new Date(baseTime).toISOString();
      insertStmt.run(`task-${i}`, `Prompt ${i}`, 'codex', i <= 3 ? 'running' : 'completed', 'ws-1', createdAt, createdAt);
    }
    for (let i = 6; i <= 10; i++) {
      const createdAt = new Date(baseTime).toISOString();
      insertStmt.run(`task-${i}`, `Prompt ${i}`, 'gpt4', 'failed', 'ws-2', createdAt, createdAt);
    }
    // Expected rowid tie-breaker: larger rowid (inserted later) comes first.
    // tasks for ws-1 (codex): rowids 1 to 5.
    // Order should be: task-5, task-4, task-3, task-2, task-1

    // Page 1: limit=2, offset=0, workspaceId=ws-1
    let response = await server.inject({
      method: 'GET',
      url: '/api/tasks',
      query: { limit: '2', offset: '0', workspaceId: 'ws-1' }
    });

    expect(response.statusCode).toBe(200);
    let body = response.json();

    expect(body.tasks).toHaveLength(2);
    expect(body.tasks[0].id).toBe('task-5');
    expect(body.tasks[1].id).toBe('task-4');
    expect(body.meta).toEqual({
      limit: 2,
      offset: 0,
      returned: 2,
      total: 5,
      hasMore: true,
      staleCount: 3,
      statusCounts: {
        'running': 3,
        'completed': 2
      },
      providerStatusCounts: [
        { provider: 'codex', status: 'completed', count: 2, staleCount: 0 },
        { provider: 'codex', status: 'running', count: 3, staleCount: 3 }
      ]
    });

    // Page 2: limit=2, offset=2, workspaceId=ws-1
    response = await server.inject({
      method: 'GET',
      url: '/api/tasks',
      query: { limit: '2', offset: '2', workspaceId: 'ws-1' }
    });

    expect(response.statusCode).toBe(200);
    body = response.json();

    expect(body.tasks).toHaveLength(2);
    expect(body.tasks[0].id).toBe('task-3');
    expect(body.tasks[1].id).toBe('task-2');
    expect(body.meta.hasMore).toBe(true);

    // Page 3: limit=2, offset=4, workspaceId=ws-1
    response = await server.inject({
      method: 'GET',
      url: '/api/tasks',
      query: { limit: '2', offset: '4', workspaceId: 'ws-1' }
    });

    expect(response.statusCode).toBe(200);
    body = response.json();

    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe('task-1');
    expect(body.meta.hasMore).toBe(false);
    expect(body.meta.total).toBe(5);

    // Combined workspace/provider + status filter
    response = await server.inject({
      method: 'GET',
      url: '/api/tasks',
      query: { workspaceId: 'ws-1', provider: 'codex', status: 'running' }
    });

    expect(response.statusCode).toBe(200);
    body = response.json();
    expect(body.tasks).toHaveLength(3);
    expect(body.meta.statusCounts).toEqual({
      'running': 3
    });
    expect(body.meta.providerStatusCounts).toEqual([
      { provider: 'codex', status: 'running', count: 3, staleCount: 3 }
    ]);
    expect(body.meta.staleCount).toBe(3);
    expect(body.meta.total).toBe(3);
  });

  it('handles limit=-1 clamps to 1 and limits to 500', async () => {
    let response = await server.inject({
      method: 'GET',
      url: '/api/tasks',
      query: { limit: '-1' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().meta.limit).toBe(1);

    response = await server.inject({
      method: 'GET',
      url: '/api/tasks',
      query: { limit: '9999' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().meta.limit).toBe(500);
  });

  it('does not count a terminal lease-expired task as stale active work', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (
        id, mode, prompt, assigned_to, status, workspace_id,
        created_at, updated_at, lease_expires_at
      ) VALUES (?, 'task', ?, 'codex', 'lease_expired', ?, ?, ?, ?)
    `).run(
      'task-terminal-lease',
      'terminal lease expiry',
      'ws-lease-terminal',
      '2020-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
      '2020-01-01T00:01:30.000Z',
    );

    const response = await server.inject({
      method: 'GET',
      url: '/api/tasks',
      query: { workspaceId: 'ws-lease-terminal' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().meta).toMatchObject({
      staleCount: 0,
      statusCounts: { lease_expired: 1 },
      providerStatusCounts: [
        { provider: 'codex', status: 'lease_expired', count: 1, staleCount: 0 },
      ],
    });
  });

  it.each(['10junk', '1.5', '9007199254740992'])('defaults strict pagination value %s instead of partially parsing it', async value => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/tasks',
      query: { limit: value, offset: value }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().meta).toMatchObject({ limit: 100, offset: 0 });
  });

  it('rejects malformed status filters with 400', async () => {
    // empty after trim
    let response = await server.inject({
      method: 'GET',
      url: '/api/tasks',
      query: { status: 'running, ,failed' }
    });
    expect(response.statusCode).toBe(400);

    // too many values
    const tooMany = Array.from({ length: 21 }, (_, i) => `status${i}`).join(',');
    response = await server.inject({
      method: 'GET',
      url: '/api/tasks',
      query: { status: tooMany }
    });
    expect(response.statusCode).toBe(400);

    // too long
    const tooLong = 'a'.repeat(51);
    response = await server.inject({
      method: 'GET',
      url: '/api/tasks',
      query: { status: tooLong }
    });
    expect(response.statusCode).toBe(400);
  });
});

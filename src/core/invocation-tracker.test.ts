import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { closeDb, getDb, runMigrations } from '../storage/database.js';
import { env } from '../utils/config.js';
import { cliMesh } from './cli-mesh.js';
import { invocationTracker } from './invocation-tracker.js';

describe.sequential('invocation completion notifications', () => {
  const testDbPath = resolve(env.ROOT, 'db/test-invocation-tracker.db');
  const sendMessage = vi.spyOn(cliMesh, 'sendMessage').mockResolvedValue(1);

  beforeAll(() => {
    closeDb();
    process.env.DATABASE_PATH = testDbPath;
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    sendMessage.mockRestore();
    closeDb();
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    delete process.env.DATABASE_PATH;
  });

  it('names the actual executor and identifies the requested provider on failover', async () => {
    const taskId = 'task-provider-failover-notification';
    getDb().prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, metadata_json)
      VALUES (?, 'task', ?, ?, 'completed', ?)
    `).run(taskId, 'prompt', 'mlx', JSON.stringify({ requestedProvider: 'codex' }));
    const invocationId = await invocationTracker.recordInvocation(
      'caller-session',
      'caller-agent',
      'codex',
      'prompt',
      'task',
      taskId,
    );
    invocationTracker.completeInvocation(invocationId, 'completed', 'done');

    await invocationTracker.notifyCompletion(invocationId);

    expect(sendMessage).toHaveBeenCalledWith(
      'nco-system',
      'nco',
      'caller-session',
      expect.stringContaining('[task] mlx 완료 (codex 요청→mlx 대행)'),
      'info',
    );
  });
});

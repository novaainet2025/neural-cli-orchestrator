import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { logDecision } from '../src/core/decision-log.js';
import { closeDb, getDb, runMigrations } from '../src/storage/database.js';
import { env } from '../src/utils/config.js';

type Gateway = Awaited<ReturnType<(typeof import('../src/server/gateway.js'))['createGateway']>>;

describe('decision log', () => {
  const testDbPath = resolve(env.ROOT, 'db/test-decision-log.db');
  let originalDbPath: string | undefined;
  let server: Gateway;

  beforeAll(async () => {
    closeDb();
    originalDbPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = testDbPath;
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    runMigrations();
    const { createGateway } = await import('../src/server/gateway.js');
    server = await createGateway();
  });

  afterAll(async () => {
    await server.close();
    closeDb();
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (originalDbPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalDbPath;
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM decision_log').run();
  });

  it('inserts a decision that can be selected', () => {
    logDecision({
      taskId: 'task-decision-test',
      phase: 'verification',
      decision: 'test:accepted',
      reason: 'ground-truth check',
      evidenceTier: 'tier-1',
      actor: 'codex',
    });

    const row = getDb().prepare(`
      SELECT task_id, phase, decision, reason, evidence_tier, actor
      FROM decision_log
      WHERE task_id = ?
    `).get('task-decision-test');

    expect(row).toEqual({
      task_id: 'task-decision-test',
      phase: 'verification',
      decision: 'test:accepted',
      reason: 'ground-truth check',
      evidence_tier: 'tier-1',
      actor: 'codex',
    });
  });

  it('returns decisions through the API', async () => {
    logDecision({ decision: 'api:test', actor: 'codex' });
    const response = await server.inject({ method: 'GET', url: '/api/decisions?limit=1' });
    const body = response.json() as { decisions: Array<{ decision: string }> };

    expect(response.statusCode).toBe(200);
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0]?.decision).toBe('api:test');
  });
});

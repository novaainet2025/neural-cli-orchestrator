import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { env } from '../src/utils/config.js';
import { closeDb, getDb, runMigrations } from '../src/storage/database.js';
import { loadRetryPayload } from '../src/server/gateway.js';
import { checkResponseQuality } from '../src/verification/response-quality.js';

describe('response quality gate', () => {
  const testDbPath = resolve(env.ROOT, 'db/test-response-quality.db');
  let originalDbPath: string;

  beforeAll(() => {
    closeDb();
    originalDbPath = env.DATABASE_PATH;
    (env as any).DATABASE_PATH = testDbPath;
    process.env.DATABASE_PATH = testDbPath;
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    getDb();
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    (env as any).DATABASE_PATH = originalDbPath;
    process.env.DATABASE_PATH = originalDbPath;
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  it('rejects thinking-only responses', () => {
    const result = checkResponseQuality('<thinking>plan only</thinking>');
    expect(result.pass).toBe(false);
    expect(result.heuristics).toContain('THINKING_ONLY');
  });

  it('rejects tool echo responses', () => {
    const result = checkResponseQuality('\n[tool:readFile]\n[tool:runCommand]\n');
    expect(result.pass).toBe(false);
    expect(result.heuristics).toContain('TOOL_ECHO');
  });

  it('rejects responses shorter than 50 non-whitespace characters', () => {
    const result = checkResponseQuality('1234567890123456789012345678901234567890123456789');
    expect(result.pass).toBe(false);
    expect(result.heuristics).toContain('EMPTY_OR_SHORT');
  });

  it('passes a long normal review response', () => {
    const result = checkResponseQuality(`done: ${'review '.repeat(500)}`);
    expect(result.pass).toBe(true);
    expect(result.heuristics).toEqual([]);
  });

  it('loads retry payload from completed tasks only when allowCompletedSource is enabled', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, completed_at, updated_at)
      VALUES (?, 'task', ?, 'codex', 'completed', datetime('now'), datetime('now'))
    `).run('task-quality-completed', 'Investigate response quality gate');

    const withoutFlag = loadRetryPayload(db, 'task-quality-completed');
    const withFlag = loadRetryPayload(db, 'task-quality-completed', { allowCompletedSource: true });

    expect(withoutFlag).toBeNull();
    expect(withFlag).not.toBeNull();
    expect(withFlag?.prompt).toBe('Investigate response quality gate');
    expect(withFlag?.ai).toBe('codex');
  });
});

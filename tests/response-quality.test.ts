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

  it('rejects empty or symbol-only responses', () => {
    expect(checkResponseQuality('').heuristics).toContain('EMPTY_OR_SHORT');
    expect(checkResponseQuality('   \n\t ').heuristics).toContain('EMPTY_OR_SHORT');
    expect(checkResponseQuality('...---!!!').heuristics).toContain('EMPTY_OR_SHORT');
  });

  it('passes short but substantive answers (retry-cap burn regression)', () => {
    // 길이 단독(<50) reject가 정당 단답을 거부해 retry cap을 전소시킨 현장 결함 회귀 방지
    expect(checkResponseQuality('OK').pass).toBe(true);
    expect(checkResponseQuality('done: 통과').pass).toBe(true);
  });

  it('rejects responses starting with a provider error marker', () => {
    const result = checkResponseQuality(
      '[codex: no final response — process failed] — Reading additional input from stdin...',
    );
    expect(result.pass).toBe(false);
    expect(result.heuristics).toContain('ERROR_MARKER');
  });

  it('passes a real response with a trailing error marker', () => {
    const result = checkResponseQuality(
      `done: ${'analysis '.repeat(100)}\n[codex: no final response — process failed] — Reading additional input from stdin...`,
    );
    expect(result.pass).toBe(true);
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

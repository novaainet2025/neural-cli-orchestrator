import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { env } from '../src/utils/config.js';
import { closeDb, getDb, runMigrations } from '../src/storage/database.js';
import {
  isCompanyOrchestratorQualityRetryOwner,
  loadRetryPayload,
} from '../src/server/gateway.js';
import { checkResponseQuality } from '../src/verification/response-quality.js';

describe('response quality gate', () => {
  const testDbPath = resolve(env.ROOT, 'db/test-response-quality.db');
  let originalDbPath: string;

  beforeAll(() => {
    closeDb();
    originalDbPath = process.env.DATABASE_PATH || '';
    process.env.DATABASE_PATH = testDbPath;
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    getDb();
    runMigrations();
  });

  afterAll(() => {
    closeDb();
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

  it('passes structured JSON responses including empty arrays (docs-ai edit-loop regression)', () => {
    // 문서편집 태스크의 정당한 답 [] 및 JSON 배열이 EMPTY_OR_SHORT/FORMAT_MISMATCH로
    // 무한 반려된 현장 결함 회귀 방지 (실측 2026-07-19)
    expect(checkResponseQuality('[]').pass).toBe(true);
    expect(checkResponseQuality('[]', { requireProtocolPrefix: true }).pass).toBe(true);
    const edits = '[{"find":"사업명","replace":"사 업 명","reason":"표기 통일"}]';
    expect(checkResponseQuality(edits, { requireProtocolPrefix: true }).pass).toBe(true);
  });

  it('still rejects non-JSON bracket noise', () => {
    expect(checkResponseQuality('[...]').heuristics).toContain('EMPTY_OR_SHORT');
    expect(
      checkResponseQuality('[broken json', { requireProtocolPrefix: true }).heuristics,
    ).toContain('FORMAT_MISMATCH');
  });

  it('rejects serialized tool-call echoes in company-owned quality gates', () => {
    const validEcho = JSON.stringify({
      name: 'searchCode',
      parameters: { query: 'quality-audit' },
    });
    const truncatedEcho = '{"name":"searchCode","parameters":{"query":"\\u3000\\u3000';

    expect(checkResponseQuality(validEcho, {
      requireProtocolPrefix: true,
      rejectToolEchoes: true,
    }).heuristics).toContain('TOOL_CALL_ECHO');
    expect(checkResponseQuality(truncatedEcho, {
      requireProtocolPrefix: true,
      rejectToolEchoes: true,
    }).heuristics).toContain('TOOL_CALL_ECHO');
  });

  it('rejects tool-description handoffs without changing ordinary documentation checks', () => {
    const description = 'The `searchFiles` function is used to find the requested file.';

    expect(checkResponseQuality(description, {
      rejectToolEchoes: true,
    }).heuristics).toContain('TOOL_DESCRIPTION');
    expect(checkResponseQuality(description).pass).toBe(true);
  });

  it('delegates quality retry only for explicitly owned company-run tasks', () => {
    expect(isCompanyOrchestratorQualityRetryOwner(JSON.stringify({
      companyRunId: 'corun-1',
      qualityRetryOwner: 'company-orchestrator',
    }))).toBe(true);
    expect(isCompanyOrchestratorQualityRetryOwner(JSON.stringify({
      companyRunId: 'corun-1',
    }))).toBe(false);
    expect(isCompanyOrchestratorQualityRetryOwner('{broken')).toBe(false);
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
      INSERT INTO tasks (
        id, mode, prompt, assigned_to, status, metadata_json, completed_at, updated_at
      )
      VALUES (?, 'task', ?, 'codex', 'completed', ?, datetime('now'), datetime('now'))
    `).run(
      'task-quality-completed',
      'Investigate response quality gate',
      JSON.stringify({
        projectDir: '/repo',
        teamId: 'team_tech-port-01-source-discovery',
        organizationId: 'org_technology-porting',
        companyRunId: 'corun-1',
        qualityRejected: true,
        qualityHeuristics: ['FORMAT_MISMATCH'],
      }),
    );

    const withoutFlag = loadRetryPayload(db, 'task-quality-completed');
    const withFlag = loadRetryPayload(db, 'task-quality-completed', { allowCompletedSource: true });

    expect(withoutFlag).toBeNull();
    expect(withFlag).not.toBeNull();
    expect(withFlag?.prompt).toBe('Investigate response quality gate');
    expect(withFlag?.ai).toBe('codex');
    expect(withFlag?.metadata).toEqual({
      projectDir: '/repo',
      teamId: 'team_tech-port-01-source-discovery',
      organizationId: 'org_technology-porting',
      companyRunId: 'corun-1',
    });
  });
});

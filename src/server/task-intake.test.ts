import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPromptGate,
  buildDefaultVerifierWithFs,
  findActiveWorkReportTask,
  getWorkReportId,
  inferTaskType,
  isCodeWorkPrompt,
  isPerformanceGoalInputPrompt,
  isTextOnlyPrompt,
  isWorkReportPrompt,
  validateProjectDirMetadataWithFs,
} from './task-intake.js';
import { checkResponseQuality } from '../verification/response-quality.js';

describe('task-intake helpers', () => {
  let database: Database.Database | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it('enriches prompts below the prompt-gate threshold', () => {
    const result = applyPromptGate('[목표] 버그 수정', { projectDir: '/repo' });

    expect(result.promptGate).toEqual({
      score: 20,
      missing: ['컨텍스트', '제약', '출력형식', '검증기준'],
      enriched: true,
    });
    expect(result.prompt).toContain('--- 자동 보강 ---');
    expect(result.prompt).toContain('[컨텍스트] 프로젝트: /repo / 작업 유형: bugfix');
  });

  it('keeps prompts that already satisfy the gate', () => {
    const prompt = [
      '[컨텍스트] repo',
      '[목표] 구현',
      '[제약] 범위 유지',
      '[출력형식] diff',
      '[검증기준] npm run build',
    ].join('\n');

    const result = applyPromptGate(prompt, { projectDir: '/repo' });

    expect(result.prompt).toBe(prompt);
    expect(result.promptGate).toEqual({ score: 100 });
  });

  it('adds the source-discovery protocol contract once and leaves other teams unchanged', () => {
    const metadata = {
      projectDir: '/repo',
      teamId: 'team_tech-port-01-source-discovery',
    };
    const first = applyPromptGate('[목표] 공식 소스를 조사한다', metadata);
    const second = applyPromptGate(first.prompt, metadata);

    expect(first.prompt).toContain('[01 Source Discovery 응답 계약]');
    expect(first.prompt).toContain('첫 줄을 `done:`');
    expect(first.prompt).toContain('`[미검증]`');
    expect(second.prompt.match(/\[01 Source Discovery 응답 계약\]/g)).toHaveLength(1);
    expect(applyPromptGate('[목표] 공식 소스를 조사한다', {
      projectDir: '/repo',
      teamId: 'team_other',
    }).prompt).not.toContain('[01 Source Discovery 응답 계약]');
  });

  it('adds the improvement-debate protocol contract only for the team or its diagnostic target', () => {
    const directMetadata = {
      projectDir: '/repo',
      teamId: 'team_tech-port-06-improvement-debate',
    };
    const direct = applyPromptGate('[목표] 개선 방향을 토론한다', directMetadata);
    const retry = applyPromptGate(direct.prompt, directMetadata);
    const diagnostic = applyPromptGate('[목표] 낮은 점수의 원인을 진단한다', {
      projectDir: '/repo',
      teamId: 'team_self-improvement',
      diagnosticTargetTeamId: 'team_tech-port-06-improvement-debate',
    });

    expect(direct.prompt).toContain('[06 Improvement Debate 응답 계약]');
    expect(direct.prompt).toContain('첫 줄을 `done:`');
    expect(direct.prompt).toContain('검증 명령과 결과, Gap, 되돌리기 방법');
    expect(retry.prompt.match(/\[06 Improvement Debate 응답 계약\]/g)).toHaveLength(1);
    expect(diagnostic.prompt).toContain('[06 Improvement Debate 응답 계약]');
    expect(applyPromptGate('[목표] 개선 방향을 토론한다', {
      projectDir: '/repo',
      teamId: 'team_other',
    }).prompt).not.toContain('[06 Improvement Debate 응답 계약]');
  });

  it('adds the evidence contract once to company-run self-improvement diagnostic teams only', () => {
    const diagnosticTeamIds = [
      'team_self-learning',
      'team_self-improvement',
      'team_error-prevention',
    ];

    for (const teamId of diagnosticTeamIds) {
      const metadata = {
        projectDir: '/repo',
        teamId,
        companyRunId: 'corun-cli-design-cycle3',
      };
      const first = applyPromptGate('[목표] cli-design 저점 원인을 검증한다', metadata);
      const retry = applyPromptGate(first.prompt, metadata);

      expect(first.prompt).toContain('[Self-Improvement Diagnostic 응답·증거 계약]');
      expect(first.prompt).toContain('첫 줄을 `done:`');
      expect(first.prompt).toContain('첫 줄을 `status:`');
      expect(first.prompt).toContain('DB 행·파일 내용·명령 출력');
      expect(first.prompt).toContain('grep 문자열 존재만으로');
      expect(retry.prompt.match(/\[Self-Improvement Diagnostic 응답·증거 계약\]/g)).toHaveLength(1);
    }

    expect(applyPromptGate('[목표] 상시 자가학습을 수행한다', {
      projectDir: '/repo',
      teamId: 'team_self-learning',
    }).prompt).not.toContain('[Self-Improvement Diagnostic 응답·증거 계약]');
    expect(applyPromptGate('[목표] 일반 회사 작업을 수행한다', {
      projectDir: '/repo',
      teamId: 'team_other',
      companyRunId: 'corun-other',
    }).prompt).not.toContain('[Self-Improvement Diagnostic 응답·증거 계약]');
  });

  it('adds the research-strategy response contract once to company runs only', () => {
    const metadata = {
      projectDir: '/repo',
      teamId: 'team_research-strategy',
      companyRunId: 'corun_research',
    };
    const first = applyPromptGate('[목표] 연구질문과 성공기준을 설계한다', metadata);
    const retry = applyPromptGate(first.prompt, metadata);

    expect(first.prompt).toContain('[Research Strategy 응답 계약]');
    expect(first.prompt).toContain('첫 줄을 `done:`');
    expect(first.prompt).toContain('첫 줄을 `status:`');
    expect(first.prompt).toContain('확인하지 않은 출처·수치·파일·검증 결과');
    expect(retry.prompt.match(/\[Research Strategy 응답 계약\]/g)).toHaveLength(1);
    expect(checkResponseQuality('done: 연구질문과 성공기준 설계를 완료했습니다.', {
      requireProtocolPrefix: true,
    })).toEqual({ pass: true, heuristics: [] });
    expect(buildDefaultVerifierWithFs({
      prompt: first.prompt,
      metadata,
      verifier: undefined,
    }, () => true)).toBeUndefined();

    expect(applyPromptGate('[목표] 일반 리서치 태스크', {
      projectDir: '/repo',
      teamId: 'team_research-strategy',
    }).prompt).not.toContain('[Research Strategy 응답 계약]');
    expect(applyPromptGate('[목표] 다른 팀 회사 태스크', {
      projectDir: '/repo',
      teamId: 'team_other',
      companyRunId: 'corun_other',
    }).prompt).not.toContain('[Research Strategy 응답 계약]');
  });

  it('keeps tool-description false reports rejected while allowing an honest blocked status', () => {
    const prompt = applyPromptGate('[목표] cli-design 저점 원인을 검증한다', {
      projectDir: '/repo',
      teamId: 'team_error-prevention',
      companyRunId: 'corun-cli-design-cycle3',
    }).prompt;
    const toolDescription = [
      'The runCommand function is used to run git status.',
      'The runTest function is used to run tests.',
    ].join(' ');
    const honestBlocked = [
      'status: list_tasks 접근이 차단되어 분석을 완료하지 못했습니다.',
      '[미검증] 실제 task 이력',
    ].join('\n');

    expect(prompt.match(/\[Self-Improvement Diagnostic 응답·증거 계약\]/g)).toHaveLength(1);
    expect(checkResponseQuality(toolDescription, {
      requireProtocolPrefix: true,
    })).toEqual({
      pass: false,
      heuristics: ['FORMAT_MISMATCH'],
    });
    expect(checkResponseQuality(honestBlocked, {
      requireProtocolPrefix: true,
    })).toEqual({
      pass: true,
      heuristics: [],
    });
  });

  it('assigns the default verifier for code work with package.json', () => {
    const verifier = buildDefaultVerifierWithFs({
      prompt: 'src/server/gateway.ts 버그 수정',
      metadata: { projectDir: '/repo' },
      verifier: undefined,
    }, () => true);

    expect(verifier).toEqual({
      type: 'run',
      command: 'npm run build',
      timeoutMs: 120_000,
    });
  });

  it('does not assign the default verifier for text-only standing missions', () => {
    const prompt = [
      '[팀 상시 임무 — 자가개선팀] (텍스트만 응답, 도구/커맨드 사용 금지)',
      '자가진단 리포트를 기반으로 NCO의 소스코드 개선, 병목 구간 최적화.',
      '[엄수] 너는 파일을 수정하거나 명령(build/test/git/make/npm 등)을 실행할 수 없다.',
    ].join('\n');

    const verifier = buildDefaultVerifierWithFs({
      prompt,
      metadata: { projectDir: '/repo' },
      verifier: undefined,
    }, () => true);
    const tersePingVerifier = buildDefaultVerifierWithFs({
      prompt: `핑 검증: 역할을 한 문장으로 답하라. 도구 금지, 텍스트만.`,
      metadata: { projectDir: '/repo' },
      verifier: undefined,
    }, () => true);

    expect(verifier).toBeUndefined();
    expect(tersePingVerifier).toBeUndefined();
  });

  it('does not assign a build verifier to work reports after prompt enrichment', () => {
    const prompt = [
      '[업무보고 작성] 2026-07-24 오전 보고서를 작성하라.',
      '요청 범위 밖 파일 수정 금지.',
      '검증기준은 빌드/타입체크 통과.',
    ].join('\n');

    expect(isWorkReportPrompt(prompt)).toBe(true);
    expect(buildDefaultVerifierWithFs({
      prompt,
      metadata: { projectDir: '/repo' },
      verifier: undefined,
    }, () => true)).toBeUndefined();
  });

  it('does not assign a build verifier to performance-goal HTTP input tasks', () => {
    const prompt = [
      '[성과보고·목표설정 입력 지시] 실제 HTTP 호출로 목표와 성과보고를 입력하라.',
      '[제약] 요청 범위 밖 파일 수정 금지. 기존 동작 회귀 금지.',
      '[검증기준] 빌드/타입체크 통과.',
    ].join('\n');

    expect(isCodeWorkPrompt(prompt)).toBe(true);
    expect(isPerformanceGoalInputPrompt(prompt)).toBe(true);
    expect(buildDefaultVerifierWithFs({
      prompt,
      metadata: { projectDir: '/repo' },
      verifier: undefined,
    }, () => true)).toBeUndefined();
  });

  it('detects text-only prompts', () => {
    expect(isTextOnlyPrompt('(텍스트만 응답, 도구/커맨드 사용 금지)')).toBe(true);
    expect(isTextOnlyPrompt('오직 텍스트만 생성한다')).toBe(true);
    expect(isTextOnlyPrompt('역할을 답하라. 도구 금지, 텍스트만.')).toBe(true);
    expect(isTextOnlyPrompt('gateway 버그 수정')).toBe(false);
  });

  it('does not assign the default verifier when projectDir lacks package.json', () => {
    const verifier = buildDefaultVerifierWithFs({
      prompt: 'src/server/gateway.ts 버그 수정',
      metadata: { projectDir: '/repo' },
      verifier: undefined,
    }, () => false);

    expect(verifier).toBeUndefined();
  });

  it('requires metadata.projectDir at task creation time', () => {
    expect(validateProjectDirMetadataWithFs(undefined, () => true)).toBe('metadata.projectDir is required');
    expect(validateProjectDirMetadataWithFs({}, () => true)).toBe('metadata.projectDir is required');
  });

  it('rejects a non-existent metadata.projectDir', () => {
    expect(validateProjectDirMetadataWithFs({ projectDir: '/missing' }, () => false)).toBe(
      'metadata.projectDir does not exist: /missing',
    );
  });

  it('classifies code-work prompts and infers task types', () => {
    expect(isCodeWorkPrompt('gateway 버그 수정')).toBe(true);
    expect(isCodeWorkPrompt('회의록 요약')).toBe(false);
    expect(inferTaskType('리팩터 진행')).toBe('refactor');
    expect(inferTaskType('새 모듈 구현')).toBe('implementation');
  });

  it('normalizes work-report ids and finds the existing active task', () => {
    database = new Database(':memory:');
    database.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        assigned_to TEXT,
        status TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      )
    `);
    const insert = database.prepare(`
      INSERT INTO tasks (id, assigned_to, status, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    insert.run('task-failed', 'codex', 'failed', '{"workReportId":"wr-1"}', '2026-07-24 00:00:00');
    insert.run('task-active', 'claude-code', 'assigned', '{"workReportId":"wr-1"}', '2026-07-24 00:01:00');

    expect(getWorkReportId({ workReportId: '  wr-1  ' })).toBe('wr-1');
    expect(getWorkReportId({ workReportId: '   ' })).toBeUndefined();
    expect(findActiveWorkReportTask(database, 'wr-1')).toEqual({
      id: 'task-active',
      assigned_to: 'claude-code',
    });
  });

  it('enforces one active task per work-report id while allowing a terminal retry', () => {
    database = new Database(':memory:');
    database.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        assigned_to TEXT,
        status TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      )
    `);
    database.exec(readFileSync(
      resolve(process.cwd(), 'db/migrations/085_active_work_report_task_idempotency.sql'),
      'utf8',
    ));
    const insert = database.prepare(`
      INSERT INTO tasks (id, assigned_to, status, metadata_json, created_at)
      VALUES (?, 'codex', ?, '{"workReportId":"wr-1"}', ?)
    `);

    insert.run('task-1', 'assigned', '2026-07-24 00:00:00');
    expect(() => insert.run('task-2', 'assigned', '2026-07-24 00:00:01'))
      .toThrow(/idx_tasks_active_work_report_id/);

    database.prepare(`UPDATE tasks SET status='failed' WHERE id='task-1'`).run();
    expect(() => insert.run('task-2', 'assigned', '2026-07-24 00:00:02')).not.toThrow();
  });
});

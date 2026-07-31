import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPromptGate,
  buildDefaultVerifierWithFs,
  findActiveWorkReportTask,
  getWorkReportId,
  GOV_COMMAND_INTAKE_RESPONSE_CONTRACT,
  INCIDENT_COMMAND_RESPONSE_CONTRACT,
  RESILIENCE_REVIEW_RESPONSE_CONTRACT,
  hasResponseContract,
  inferTaskType,
  isCodeWorkPrompt,
  isPerformanceGoalInputPrompt,
  isReadOnlyTaskPrompt,
  isTextOnlyPrompt,
  isWorkReportPrompt,
  shouldApplyPromptGateForProvider,
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

  it('uses a report-body contract without code instructions (2026-07-28 mission-intake empty-output incident)', () => {
    const prompt = [
      '[업무보고 작성] 2026-07-28 오후 보고서를 작성하라.',
      '팀: Mission Intake and Portfolio',
      '[실데이터] ...',
    ].join('\n');

    const result = applyPromptGate(prompt, { projectDir: '/repo' });

    expect(result.prompt).not.toContain('빌드/타입체크 통과');
    expect(result.prompt).not.toContain('변경 파일 목록 + 핵심 diff 요약');
    expect(result.prompt).toContain('[출력형식] (자동 보강) 요구된 Markdown 업무보고 본문.');
    expect(result.prompt).toContain('파일 변경 없음 — 빌드/타입체크 불필요');
  });

  it('repairs a legacy auto-generated code output contract when a work report is retried', () => {
    const prompt = [
      '[업무보고 작성] 2026-07-28 오후 보고서를 작성하라.',
      '[컨텍스트] 프로젝트: /repo',
      '[목표] 업무보고 작성',
      '[제약] 실데이터만 사용',
      '[출력형식] (자동 보강) 변경 파일 목록 + 핵심 diff 요약.',
      '[검증기준] 실데이터와 본문 대조',
    ].join('\n');

    const result = applyPromptGate(prompt, { projectDir: '/repo' });

    expect(result.promptGate).toEqual({ score: 100 });
    expect(result.prompt).not.toContain('변경 파일 목록 + 핵심 diff 요약');
    expect(result.prompt).toContain('[출력형식] (자동 보강) 요구된 Markdown 업무보고 본문.');
  });

  it('does not inject build instructions into JSON-only structured output tasks', () => {
    const result = applyPromptGate(
      '[목표] 문서 메타데이터를 수정하고 오직 JSON 배열만 출력하라.',
      { projectDir: '/repo' },
    );

    expect(result.prompt).not.toContain('빌드/타입체크 통과');
    expect(result.prompt).not.toContain('변경 파일 목록 + 핵심 diff 요약');
    expect(result.prompt).toContain('[출력형식] (자동 보강) 요구된 JSON 형식만 출력.');
    expect(result.prompt).toContain('파일 변경 없음 — 빌드/타입체크 불필요');
  });

  it('uses text-only and performance-goal output formats instead of a code diff contract', () => {
    const textOnly = applyPromptGate(
      '[팀 상시 임무] 도구 금지, 텍스트만 응답',
      { projectDir: '/repo' },
    );
    const performanceGoal = applyPromptGate(
      '[성과보고·목표설정 입력 지시] 목표값을 입력하라.',
      { projectDir: '/repo' },
    );

    expect(textOnly.prompt).toContain('[출력형식] (자동 보강) 요구된 텍스트 본문만 출력.');
    expect(performanceGoal.prompt).toContain('[출력형식] (자동 보강) 요청된 목표·성과 입력 결과와 검증 근거 요약.');
    expect(textOnly.prompt).not.toContain('변경 파일 목록 + 핵심 diff 요약');
    expect(performanceGoal.prompt).not.toContain('변경 파일 목록 + 핵심 diff 요약');
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

  it('does not add the source-discovery contract to routine work-report/perf-goal prompts (2026-07-27 FORMAT_MISMATCH incident, task_oFksRs9zeIa0euYV)', () => {
    const metadata = {
      projectDir: '/repo',
      teamId: 'team_tech-port-01-source-discovery',
    };
    const workReport = applyPromptGate(
      '[업무보고 작성] 2026-07-27 오전 보고서를 작성하라.',
      metadata,
    );
    const perfGoal = applyPromptGate(
      '[성과보고·목표설정 입력 지시] 목표값을 입력하라.',
      metadata,
    );

    expect(hasResponseContract(workReport.prompt)).toBe(false);
    expect(hasResponseContract(perfGoal.prompt)).toBe(false);
    expect(workReport.prompt).not.toContain('[01 Source Discovery 응답 계약]');
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

  it('adds the gov-command-intake evidence contract once to company runs only and excludes build verifier', () => {
    const metadata = {
      projectDir: '/repo',
      teamId: 'team_gov-command-intake',
      companyRunId: 'corun_nco-command-cycle3',
    };
    const first = applyPromptGate('[목표] 미션을 접수하고 정규화한다', metadata);
    const retry = applyPromptGate(first.prompt, metadata);

    expect(first.prompt).toContain(GOV_COMMAND_INTAKE_RESPONSE_CONTRACT);
    expect(first.prompt).toContain('첫 줄을 `done:`');
    expect(first.prompt).toContain('DB 행·파일 내용·명령 출력');
    expect(first.prompt).toContain('[미검증]');
    expect(retry.prompt.match(/\[Gov Command Intake 응답·증거 계약\]/g)).toHaveLength(1);

    expect(hasResponseContract(first.prompt)).toBe(true);

    expect(buildDefaultVerifierWithFs({
      prompt: first.prompt,
      metadata,
      verifier: undefined,
    }, () => true)).toBeUndefined();

    expect(applyPromptGate('[목표] 독립 미션 접수 태스크', {
      projectDir: '/repo',
      teamId: 'team_gov-command-intake',
    }).prompt).not.toContain(GOV_COMMAND_INTAKE_RESPONSE_CONTRACT);
    expect(applyPromptGate('[목표] 다른 팀 태스크', {
      projectDir: '/repo',
      teamId: 'team_other',
      companyRunId: 'corun-other',
    }).prompt).not.toContain(GOV_COMMAND_INTAKE_RESPONSE_CONTRACT);
  });

  it('adds the incident-command evidence contract once to HR company runs only', () => {
    const metadata = {
      projectDir: '/repo',
      teamId: 'team_gov-command-incident',
      companyRunId: 'corun_nco-self-improve-cycle1',
    };
    const first = applyPromptGate(
      '[HR DIRECTIVE] Improve team Incident and Continuity Command. Current score=6.1, completion=0%.',
      metadata,
    );
    const retry = applyPromptGate(first.prompt, metadata);

    expect(first.prompt).toContain(INCIDENT_COMMAND_RESPONSE_CONTRACT);
    expect(first.prompt).toContain('T1(파일·DB row·HTTP 본문·명령 출력)');
    expect(first.prompt).toContain('bounded 되돌리기');
    expect(retry.prompt.match(/\[Incident Command 응답·증거 계약\]/g)).toHaveLength(1);
    expect(hasResponseContract(first.prompt)).toBe(true);

    expect(applyPromptGate('[업무보고 작성] 2026-07-30 오후 보고서를 작성하라.', {
      projectDir: '/repo',
      teamId: 'team_gov-command-incident',
      workReportId: 'wr_example',
    }).prompt).not.toContain(INCIDENT_COMMAND_RESPONSE_CONTRACT);

    expect(applyPromptGate('[목표] 독립 인시던트 태스크', {
      projectDir: '/repo',
      teamId: 'team_gov-command-incident',
    }).prompt).not.toContain(INCIDENT_COMMAND_RESPONSE_CONTRACT);
  });

  it('adds the resilience-review evidence contract once to HR company runs only', () => {
    const metadata = {
      projectDir: '/repo',
      teamId: 'team_gov-assurance-resilience',
      companyRunId: 'corun_nco-self-improve-cycle1',
    };
    const first = applyPromptGate(
      '[HR DIRECTIVE] Improve team Reliability and Resilience Review. Current score=6.1, completion=0%.',
      metadata,
    );
    const retry = applyPromptGate(first.prompt, metadata);

    expect(first.prompt).toContain(RESILIENCE_REVIEW_RESPONSE_CONTRACT);
    expect(first.prompt).toContain('T1(HTTP 응답 본문·DB row·파일·명령 출력)');
    expect(first.prompt).toContain('bounded 되돌리기');
    expect(retry.prompt.match(/\[Resilience Review 응답·증거 계약\]/g)).toHaveLength(1);
    expect(hasResponseContract(first.prompt)).toBe(true);

    expect(applyPromptGate('[업무보고 작성] 2026-07-30 오후 보고서를 작성하라.', {
      projectDir: '/repo',
      teamId: 'team_gov-assurance-resilience',
      workReportId: 'wr_example',
    }).prompt).not.toContain(RESILIENCE_REVIEW_RESPONSE_CONTRACT);

    expect(applyPromptGate('[목표] 독립 복원력 검토 태스크', {
      projectDir: '/repo',
      teamId: 'team_gov-assurance-resilience',
    }).prompt).not.toContain(RESILIENCE_REVIEW_RESPONSE_CONTRACT);
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

  it('requires protocol prefixes only when the prompt contains an explicit response contract', () => {
    expect(hasResponseContract('[목표] 코드 구현\n[Quality Audit 응답 계약]')).toBe(true);
    expect(hasResponseContract('[05 Upgrade Regression 응답 계약]\n첫 줄 done:')).toBe(true);
    expect(hasResponseContract('[목표] 코드 구현\n[검증기준] npm run build')).toBe(false);
    expect(hasResponseContract(null)).toBe(false);
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

  it('does not run a write-producing build verifier for read-only UI company checks', () => {
    const prompt = [
      '[목표] UI회사 실행 경로를 검증한다.',
      '담당 범위에서 최소 1개의 읽기 전용 T1 근거를 확인한다.',
      '[제약] 대상 저장소의 파일 생성·수정·삭제·포맷·커밋·설치 금지.',
      '[검증기준] 실제 파일 내용과 HTTP GET 본문을 대조한다.',
    ].join('\n');

    expect(isCodeWorkPrompt(prompt)).toBe(true);
    expect(isReadOnlyTaskPrompt(prompt)).toBe(true);
    expect(isReadOnlyTaskPrompt(
      '[실행 검증] UI회사 작업을 읽기 전용으로 검증한다. 파일 생성·수정·삭제는 금지한다.',
    )).toBe(true);
    expect(isReadOnlyTaskPrompt(
      '[실행 검증] UI회사 작업을 읽기 전용으로 실제 실행한다. build는 금지한다.',
    )).toBe(true);
    expect(buildDefaultVerifierWithFs({
      prompt,
      metadata: { projectDir: '/repo', companyRunId: 'corun_ui' },
      verifier: undefined,
    }, () => true)).toBeUndefined();
  });

  it('uses a read-only prompt contract and repairs legacy code-work enrichment', () => {
    const metadata = {
      projectDir: '/repo',
      companyRunId: 'corun_ui',
      teamId: 'team_ui-visual-design',
      readOnly: true,
    };
    const fresh = applyPromptGate(
      '[회사 목표] UI회사 작업을 읽기 전용으로 실제 실행한다. 파일 쓰기·build 금지.',
      metadata,
    );
    const legacy = applyPromptGate([
      '[회사 목표] UI회사 작업을 읽기 전용으로 실제 실행한다.',
      '[컨텍스트] 프로젝트: /repo',
      '[목표] UI를 검사한다.',
      '[제약] 파일 수정 금지.',
      '[출력형식] (자동 보강) 변경 파일 목록 + 핵심 diff 요약.',
      '[검증기준] (자동 보강) cd /repo && 빌드/타입체크 통과.',
    ].join('\n'), metadata);

    for (const result of [fresh, legacy]) {
      expect(result.prompt).toContain('읽기 전용 점검 결과와 실제 확인 근거 요약 (파일 변경 없음).');
      expect(result.prompt).toContain('파일 변경 없음 — 빌드/타입체크 불필요');
      expect(result.prompt).not.toContain('변경 파일 목록 + 핵심 diff 요약');
      expect(result.prompt).not.toContain('cd /repo && 빌드/타입체크 통과');
    }
  });

  it('supports an explicit readOnly metadata contract without weakening code tasks', () => {
    const prompt = 'src/server/gateway.ts 버그 수정';

    expect(buildDefaultVerifierWithFs({
      prompt,
      metadata: { projectDir: '/repo', readOnly: true },
      verifier: undefined,
    }, () => true)).toBeUndefined();
    expect(buildDefaultVerifierWithFs({
      prompt,
      metadata: { projectDir: '/repo' },
      verifier: undefined,
    }, () => true)).toEqual({
      type: 'run',
      command: 'npm run build',
      timeoutMs: 120_000,
    });
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

  it('applies the prompt gate to normal or unspecified providers', () => {
    expect(shouldApplyPromptGateForProvider('codex')).toBe(true);
    expect(shouldApplyPromptGateForProvider(undefined)).toBe(true);
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

import { existsSync } from 'fs';
import { resolve } from 'path';
import type Database from 'better-sqlite3';
import type { CreateTaskInputType } from '../utils/validation.js';
import { analyzePrompt, enrichPrompt } from './prompt-gate.js';

export type PromptGateInfo =
  | {
    score: number;
  }
  | {
    score: number;
    missing: string[];
    enriched: true;
  };

const CODE_WORK_PATTERN = /\b(implement|implementation|fix|bug|patch|refactor|refactoring|code|build)\b|구현|수정|버그|리팩터|리팩토링|코드/i;

// 텍스트 전용 상시 임무(team-runner charter 등)는 워커가 명령 실행이 금지되어 있어
// 빌드 검증기(verifier)를 붙일 수 없다. verifier가 붙으면 gateway의 품질 게이트가
// requireProtocolPrefix=true로 전환되어 자유형 리포트를 FORMAT_MISMATCH로 무한 반려한다
// (실측 2026-07-18: 자가개선팀 등 상시 임무 반복 반려). 이 마커가 있으면 검증기를 생략한다.
const TEXT_ONLY_PATTERN = /텍스트만\s*응답|오직\s*텍스트만\s*생성|도구\s*\/\s*커맨드\s*사용\s*금지|도구\s*금지\s*,?\s*텍스트만/;

// 문서 편집(docs-ai) 태스크는 편집 규칙 보일러플레이트의 "수정" 때문에 CODE_WORK로
// 오분류되어 npm build 검증기가 붙고, 게이트가 JSON 배열 응답을 FORMAT_MISMATCH로
// 무한 반려한다 (실측 2026-07-19). "오직 JSON …만" 출력 지시가 있으면 검증기를 생략한다.
const STRUCTURED_OUTPUT_PATTERN = /오직\s*JSON\s*(?:배열|객체)?\s*만/i;
const WORK_REPORT_PATTERN = /^\s*\[업무보고 작성\]/;
const PERFORMANCE_GOAL_INPUT_PATTERN = /^\s*\[성과보고·목표설정 입력 지시\]/;
const SOURCE_DISCOVERY_TEAM_ID = 'team_tech-port-01-source-discovery';
const SOURCE_DISCOVERY_RESPONSE_CONTRACT = '[01 Source Discovery 응답 계약]';
const IMPROVEMENT_DEBATE_TEAM_ID = 'team_tech-port-06-improvement-debate';
const IMPROVEMENT_DEBATE_RESPONSE_CONTRACT = '[06 Improvement Debate 응답 계약]';
const SELF_IMPROVEMENT_DIAGNOSTIC_TEAM_IDS = new Set([
  'team_self-learning',
  'team_self-improvement',
  'team_error-prevention',
]);
const SELF_IMPROVEMENT_DIAGNOSTIC_RESPONSE_CONTRACT = '[Self-Improvement Diagnostic 응답·증거 계약]';
const RESEARCH_STRATEGY_TEAM_ID = 'team_research-strategy';
const RESEARCH_STRATEGY_RESPONSE_CONTRACT = '[Research Strategy 응답 계약]';

export interface ActiveWorkReportTask {
  id: string;
  assigned_to: string | null;
}

export function isCodeWorkPrompt(prompt: string): boolean {
  return CODE_WORK_PATTERN.test(prompt);
}

export function isTextOnlyPrompt(prompt: string): boolean {
  return TEXT_ONLY_PATTERN.test(prompt);
}

export function isStructuredOutputPrompt(prompt: string): boolean {
  return STRUCTURED_OUTPUT_PATTERN.test(prompt);
}

export function isWorkReportPrompt(prompt: string): boolean {
  return WORK_REPORT_PATTERN.test(prompt);
}

export function isPerformanceGoalInputPrompt(prompt: string): boolean {
  return PERFORMANCE_GOAL_INPUT_PATTERN.test(prompt);
}

/**
 * Verifier-backed 태스크가 응답 첫 줄 protocol을 요구하면서도 프롬프트에는 계약이
 * 없어 FORMAT_MISMATCH가 반복된 실측 팀에만 결정론적 계약을 추가한다.
 * 재시도는 원 프롬프트를 다시 intake하므로 marker로 중복 추가를 막는다.
 */
export function applyTeamResponseContract(
  prompt: string,
  metadata?: Record<string, unknown>,
): string {
  const companyRunId = typeof metadata?.companyRunId === 'string'
    ? metadata.companyRunId.trim()
    : '';
  const teamId = typeof metadata?.teamId === 'string' ? metadata.teamId : '';
  if (companyRunId && SELF_IMPROVEMENT_DIAGNOSTIC_TEAM_IDS.has(teamId)) {
    if (prompt.includes(SELF_IMPROVEMENT_DIAGNOSTIC_RESPONSE_CONTRACT)) return prompt;
    return [
      prompt,
      '',
      SELF_IMPROVEMENT_DIAGNOSTIC_RESPONSE_CONTRACT,
      '- 현재 단계와 요청된 검증을 실제로 완료했으면 첫 줄을 `done:`으로 시작한다.',
      '- 데이터·권한·도구 부족, 부분 완료 또는 차단 상태이면 첫 줄을 `status:`로 시작하고 `[미검증]` 항목을 명시한다.',
      '- 실행 실패를 보고할 때는 첫 줄을 `error:`로 시작하고 실제 오류와 재현 조건을 기록한다.',
      '- task ID, 상태, 수치, 파일 변경, 테스트 결과는 DB 행·파일 내용·명령 출력처럼 재검증 가능한 근거가 있을 때만 주장한다.',
      '- 도구 함수 설명, 이전 단계 출력 반복, 다른 팀 결과 또는 grep 문자열 존재만으로 현재 작업의 완료를 주장하지 않는다.',
      '- 변경 작업이면 변경 경로, 실제 검증 결과, Gap과 되돌리기 방법을 기록하고, 변경이 불필요하면 근거와 diff 0을 명시한다.',
    ].join('\n');
  }

  // research-strategy company run은 build verifier가 protocol prefix를 요구하지만 원래
  // 프롬프트에는 그 계약이 없어, 실질 산출물을 낸 completed 부모도 FORMAT_MISMATCH로
  // 반복 반려됐다(2026-07-24 48h: company-orchestrator 부모 3건, direct retry 8건).
  // 회사 실행에만 계약을 주입해 일반 업무보고·핑·독립 태스크의 출력 형식은 바꾸지 않는다.
  if (companyRunId && teamId === RESEARCH_STRATEGY_TEAM_ID) {
    if (prompt.includes(RESEARCH_STRATEGY_RESPONSE_CONTRACT)) return prompt;
    return [
      prompt,
      '',
      RESEARCH_STRATEGY_RESPONSE_CONTRACT,
      '- 요구한 연구질문 분해·범위·방법론·성공기준·핸드오프를 완료했으면 첫 줄을 `done:`으로 시작한다.',
      '- 자료·권한·도구 부족, 부분 완료 또는 차단 상태이면 첫 줄을 `status:`로 시작하고 `[미검증]` 항목을 명시한다.',
      '- 실행 실패를 보고할 때는 첫 줄을 `error:`로 시작하고 실제 오류와 재현 조건을 기록한다.',
      '- 확인하지 않은 출처·수치·파일·검증 결과를 만들지 않는다.',
    ].join('\n');
  }

  if (metadata?.teamId === SOURCE_DISCOVERY_TEAM_ID) {
    if (prompt.includes(SOURCE_DISCOVERY_RESPONSE_CONTRACT)) return prompt;
    return [
      prompt,
      '',
      SOURCE_DISCOVERY_RESPONSE_CONTRACT,
      '- 요구한 소스 발굴을 실제로 완료했으면 첫 줄을 `done:`으로 시작한다.',
      '- 자료 부족·접근 불가·미완료이면 첫 줄을 `status:`로 시작하고 확인하지 못한 항목을 `[미검증]`으로 표시한다.',
      '- 후보 dossier를 요구받은 경우 공식 URL, 버전 또는 commit SHA, 검증일, 라이선스·보안 상태, 대안을 근거와 함께 기록한다.',
      '- 도구 함수 설명이나 지시문 반복을 현재 작업의 산출물로 대신하지 않으며, 확인하지 않은 수치·완료 상태를 만들지 않는다.',
    ].join('\n');
  }

  const targetsImprovementDebate = metadata?.teamId === IMPROVEMENT_DEBATE_TEAM_ID
    || metadata?.diagnosticTargetTeamId === IMPROVEMENT_DEBATE_TEAM_ID;
  if (!targetsImprovementDebate) return prompt;
  if (prompt.includes(IMPROVEMENT_DEBATE_RESPONSE_CONTRACT)) return prompt;

  return [
    prompt,
    '',
    IMPROVEMENT_DEBATE_RESPONSE_CONTRACT,
    '- 요구한 토론·개선 작업과 검증을 실제로 완료했으면 첫 줄을 `done:`으로 시작한다.',
    '- 데이터·권한 부족 또는 미완료이면 첫 줄을 `status:`로 시작하고 확인하지 못한 항목을 `[미검증]`으로 표시한다.',
    '- 소스 변경 작업이면 변경 경로, 검증 명령과 결과, Gap, 되돌리기 방법을 기록한다.',
    '- 도구 함수 설명, 이전 단계 출력의 반복 또는 다른 팀 결과를 현재 작업 산출물로 대신하지 않는다.',
  ].join('\n');
}

export function inferTaskType(prompt: string): string | undefined {
  if (/(?:refactor|refactoring|리팩터|리팩토링)/i.test(prompt)) return 'refactor';
  if (/(?:bug|fix|patch|버그|수정)/i.test(prompt)) return 'bugfix';
  if (/(?:implement|implementation|구현)/i.test(prompt)) return 'implementation';
  return undefined;
}

export function getWorkReportId(metadata?: Record<string, unknown>): string | undefined {
  const workReportId = typeof metadata?.workReportId === 'string'
    ? metadata.workReportId.trim()
    : '';
  return workReportId || undefined;
}

export function findActiveWorkReportTask(
  database: Database.Database,
  workReportId: string,
): ActiveWorkReportTask | undefined {
  return database.prepare(`
    SELECT id, assigned_to
    FROM tasks
    WHERE status IN ('pending','queued','assigned','running','streaming','reviewing')
      AND json_valid(metadata_json)
      AND json_extract(metadata_json, '$.workReportId') = ?
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `).get(workReportId) as ActiveWorkReportTask | undefined;
}

export function applyPromptGate(prompt: string, metadata?: Record<string, unknown>): {
  prompt: string;
  promptGate: PromptGateInfo;
} {
  const analysis = analyzePrompt(prompt);
  if (analysis.score < 60) {
    return {
      prompt: applyTeamResponseContract(
        enrichPrompt(prompt, {
          projectDir: typeof metadata?.projectDir === 'string' ? metadata.projectDir : undefined,
          taskType: inferTaskType(prompt),
        }),
        metadata,
      ),
      promptGate: {
        score: analysis.score,
        missing: analysis.missing,
        enriched: true,
      },
    };
  }

  return {
    prompt: applyTeamResponseContract(prompt, metadata),
    promptGate: { score: analysis.score },
  };
}

export function buildDefaultVerifier(input: Pick<CreateTaskInputType, 'prompt' | 'metadata' | 'verifier'>): CreateTaskInputType['verifier'] | undefined {
  return buildDefaultVerifierWithFs(input, existsSync);
}

export function validateProjectDirMetadata(metadata?: Record<string, unknown>): string | undefined {
  return validateProjectDirMetadataWithFs(metadata, existsSync);
}

export function validateProjectDirMetadataWithFs(
  metadata: Record<string, unknown> | undefined,
  pathExists: (path: string) => boolean,
): string | undefined {
  const projectDir = typeof metadata?.projectDir === 'string' ? metadata.projectDir.trim() : '';
  if (!projectDir) return 'metadata.projectDir is required';
  if (!pathExists(projectDir)) return `metadata.projectDir does not exist: ${projectDir}`;
  return undefined;
}

export function buildDefaultVerifierWithFs(
  input: Pick<CreateTaskInputType, 'prompt' | 'metadata' | 'verifier'>,
  pathExists: (path: string) => boolean,
): CreateTaskInputType['verifier'] | undefined {
  if (input.verifier) return input.verifier;
  const projectDir = typeof input.metadata?.projectDir === 'string' ? input.metadata.projectDir : undefined;
  if (!projectDir || !isCodeWorkPrompt(input.prompt)) return undefined;
  if (isTextOnlyPrompt(input.prompt)) return undefined;
  if (isStructuredOutputPrompt(input.prompt)) return undefined;
  // 업무보고는 prompt-gate 보강문의 "수정/빌드" 때문에 코드 작업으로 오탐될 수 있다.
  // 자유형 Markdown 보고에는 기본 build verifier를 붙이지 않는다.
  if (isWorkReportPrompt(input.prompt)) return undefined;
  // 목표/성과 입력은 HTTP 제어면 작업이다. prompt-gate 보강문의 "수정/빌드"를 코드 작업으로
  // 오인하면 실제 POST 성공 여부와 무관한 build/format gate가 추가된다.
  if (isPerformanceGoalInputPrompt(input.prompt)) return undefined;
  if (!pathExists(resolve(projectDir, 'package.json'))) return undefined;

  return {
    type: 'run',
    command: 'npm run build',
    timeoutMs: 120_000,
  };
}

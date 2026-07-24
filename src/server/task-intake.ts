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
const TEXT_ONLY_PATTERN = /텍스트만\s*응답|오직\s*텍스트만\s*생성|도구\s*\/\s*커맨드\s*사용\s*금지/;

// 문서 편집(docs-ai) 태스크는 편집 규칙 보일러플레이트의 "수정" 때문에 CODE_WORK로
// 오분류되어 npm build 검증기가 붙고, 게이트가 JSON 배열 응답을 FORMAT_MISMATCH로
// 무한 반려한다 (실측 2026-07-19). "오직 JSON …만" 출력 지시가 있으면 검증기를 생략한다.
const STRUCTURED_OUTPUT_PATTERN = /오직\s*JSON\s*(?:배열|객체)?\s*만/i;
const WORK_REPORT_PATTERN = /^\s*\[업무보고 작성\]/;
const SOURCE_DISCOVERY_TEAM_ID = 'team_tech-port-01-source-discovery';
const SOURCE_DISCOVERY_RESPONSE_CONTRACT = '[01 Source Discovery 응답 계약]';

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

/**
 * Team 01의 verifier-backed 태스크는 응답 첫 줄 protocol을 요구하면서도 프롬프트에는
 * 그 계약이 없어 FORMAT_MISMATCH가 반복됐다. 팀 범위에만 결정론적 계약을 추가한다.
 * 재시도는 원 프롬프트를 다시 intake하므로 marker로 중복 추가를 막는다.
 */
export function applyTeamResponseContract(
  prompt: string,
  metadata?: Record<string, unknown>,
): string {
  if (metadata?.teamId !== SOURCE_DISCOVERY_TEAM_ID) return prompt;
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
  if (!pathExists(resolve(projectDir, 'package.json'))) return undefined;

  return {
    type: 'run',
    command: 'npm run build',
    timeoutMs: 120_000,
  };
}

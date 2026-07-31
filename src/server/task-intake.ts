import { existsSync } from 'fs';
import { resolve } from 'path';
import type Database from 'better-sqlite3';
import type { CreateTaskInputType } from '../utils/validation.js';
import { analyzePrompt, enrichPrompt } from './prompt-gate.js';
import {
  GOV_COMMAND_INTAKE_RESPONSE_CONTRACT,
  INCIDENT_COMMAND_RESPONSE_CONTRACT,
  RESILIENCE_REVIEW_RESPONSE_CONTRACT,
  hasResponseContract,
  IMPROVEMENT_DEBATE_RESPONSE_CONTRACT,
  QUALITY_AUDIT_RESPONSE_CONTRACT,
  RESEARCH_STRATEGY_RESPONSE_CONTRACT,
  SELF_IMPROVEMENT_DIAGNOSTIC_RESPONSE_CONTRACT,
  SOURCE_DISCOVERY_RESPONSE_CONTRACT,
} from '../core/response-contract.js';

export {
  GOV_COMMAND_INTAKE_RESPONSE_CONTRACT,
  INCIDENT_COMMAND_RESPONSE_CONTRACT,
  RESILIENCE_REVIEW_RESPONSE_CONTRACT,
  hasResponseContract,
} from '../core/response-contract.js';

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

// 읽기 전용 감사·검사 태스크는 제약문의 "파일 수정 금지" 때문에 CODE_WORK로
// 오분류될 수 있다. 이 경우 기본 npm build verifier가 대상 저장소를 실제로 쓰므로
// 읽기 전용 불변식을 깨뜨린다. 명시적인 read-only/읽기 전용 실행 지시만 제외한다.
const READ_ONLY_TASK_PATTERN = /읽기\s*전용(?:으로)?\s*(?:T1\s*)?(?:실제\s*)?(?:명령|검사|검증|감사|확인|근거|실행)|read[\s-]*only\s+(?:command|check|verification|audit|inspection|evidence|execution|run)/i;

// 문서 편집(docs-ai) 태스크는 편집 규칙 보일러플레이트의 "수정" 때문에 CODE_WORK로
// 오분류되어 npm build 검증기가 붙고, 게이트가 JSON 배열 응답을 FORMAT_MISMATCH로
// 무한 반려한다 (실측 2026-07-19). "오직 JSON …만" 출력 지시가 있으면 검증기를 생략한다.
const STRUCTURED_OUTPUT_PATTERN = /오직\s*JSON\s*(?:배열|객체)?\s*만/i;
const WORK_REPORT_PATTERN = /^\s*\[업무보고 작성\]/;
const PERFORMANCE_GOAL_INPUT_PATTERN = /^\s*\[성과보고·목표설정 입력 지시\]/;
const AUTO_CODE_OUTPUT_FORMAT = '[출력형식] (자동 보강) 변경 파일 목록 + 핵심 diff 요약.';
const AUTO_CODE_VERIFICATION_PATTERN = /^\[검증기준\] \(자동 보강\) (?:cd .+ && )?빌드\/타입체크 통과\.$/m;
const READ_ONLY_OUTPUT_FORMAT = '읽기 전용 점검 결과와 실제 확인 근거 요약 (파일 변경 없음).';
const READ_ONLY_VERIFICATION = '[검증기준] (자동 보강) 본문 서술이 제공된 실데이터 수치·사실과 일치하는지 대조 확인 (파일 변경 없음 — 빌드/타입체크 불필요).';
const SOURCE_DISCOVERY_TEAM_ID = 'team_tech-port-01-source-discovery';
const IMPROVEMENT_DEBATE_TEAM_IDS = new Set(['team_tech-port-06-improvement-debate', 'team_tech-port-06-decision-2026']);
const SELF_IMPROVEMENT_DIAGNOSTIC_TEAM_IDS = new Set([
  'team_self-learning',
  'team_self-improvement',
  'team_error-prevention',
]);
const RESEARCH_STRATEGY_TEAM_IDS = new Set(['team_research-strategy', 'team_research-strategy-2026']);
const QUALITY_AUDIT_TEAM_IDS = new Set(['team_quality-audit', 'team_content-quality']);
const GOV_COMMAND_INTAKE_TEAM_ID = 'team_gov-command-intake';
const GOV_COMMAND_INCIDENT_TEAM_ID = 'team_gov-command-incident';
const GOV_ASSURANCE_RESILIENCE_TEAM_ID = 'team_gov-assurance-resilience';

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

export function isReadOnlyTaskPrompt(prompt: string): boolean {
  return READ_ONLY_TASK_PATTERN.test(prompt);
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
  if (companyRunId && RESEARCH_STRATEGY_TEAM_IDS.has(teamId)) {
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

  // quality-audit 팀은 build verifier가 protocol prefix를 요구하는데 원래 프롬프트에는
  // 계약이 없어 실질 산출물을 낸 completed 태스크도 FORMAT_MISMATCH로 반려될 수 있다.
  // 팀이 자유형 감사 보고서를 작성하는 경우에도 프리픽스(quality-gate 통과)를 요구하므로
  // 항상(회사 실행 외부에서도) 계약을 주입해 일관된 형식을 보장한다.
  if (typeof metadata?.teamId === 'string' && QUALITY_AUDIT_TEAM_IDS.has(metadata.teamId)) {
    if (prompt.includes(QUALITY_AUDIT_RESPONSE_CONTRACT)) return prompt;
    return [
      prompt,
      '',
      QUALITY_AUDIT_RESPONSE_CONTRACT,
      '- 감사·검수를 실제로 완료했으면 첫 줄을 `done:`으로 시작한다.',
      '- 자료·권한 부족, 부분 감사 또는 차단 상태이면 첫 줄을 `status:`로 시작하고 `[미검증]` 항목을 명시한다.',
      '- 실행 실패를 보고할 때는 첫 줄을 `error:`로 시작하고 실제 오류와 재현 조건을 기록한다.',
      '- 주장하는 모든 수치·파일·검증 결과는 재검증 가능한 근거(DB 행, 파일 내용, 명령 출력)가 있어야 한다.',
      '- 도구 함수 설명, 이전 단계 출력 반복, grep 문자열 존재만으로 현재 작업의 완료를 주장하지 않는다.',
    ].join('\n');
  }

  // gov-command-intake 팀의 회사 실행 태스크는 미션 접수·정규화를 담당하며,
  // company-orchestrator가 isCompanyStageOutputAcceptable에서 protocol prefix를
  // 요구(done:/status:/error:)하지만 프롬프트에 계약이 없으면 에이전트가 자유형
  // 응답을 하고, hasResponseContract=false로 requireProtocolPrefix가 꺼져 품질게이트가
  // 형식을 검증하지 못한다. 또한 prompt-gate 보강 시 코드 작업 형식(변경 파일 목록 + diff)
  // 이 주입되어 미션 접수 태스크와 부정합이 생긴다. 회사 실행에만 계약을 주입해
  // 일반(비회사) gov-command-intake 태스크의 출력 형식은 바꾸지 않는다.
  if (companyRunId && teamId === GOV_COMMAND_INTAKE_TEAM_ID) {
    if (prompt.includes(GOV_COMMAND_INTAKE_RESPONSE_CONTRACT)) return prompt;
    return [
      prompt,
      '',
      GOV_COMMAND_INTAKE_RESPONSE_CONTRACT,
      '- 미션 접수·정규화·유효성검사를 실제로 완료했으면 첫 줄을 `done:`으로 시작한다.',
      '- 데이터·권한 부족, 부분 완료 또는 차단 상태이면 첫 줄을 `status:`로 시작하고 `[미검증]` 항목을 명시한다.',
      '- 실행 실패를 보고할 때는 첫 줄을 `error:`로 시작하고 실제 오류와 재현 조건을 기록한다.',
      '- 접수된 미션 ID, 상태, 정규화 결과는 DB 행·파일 내용·명령 출력처럼 재검증 가능한 근거가 있을 때만 주장한다.',
      '- 도구 함수 설명, 이전 단계 출력의 반복, grep 문자열 존재만으로 현재 작업의 완료를 주장하지 않는다.',
    ].join('\n');
  }

  // gov-command-incident HR 개선·회사 실행 태스크는 장애 선언·영향범위·복구책임을 보고하지만,
  // 텍스트 전용 관찰 루프만 반복하면 done: 선언과 T1 증거가 분리된다(실측 2026-07-28~30
  // team-runner 산출물: "미확인" 항목 다수 + done: 동시 존재). 회사 실행(companyRunId)에만
  // 계약을 주입해 일일 업무보고(workReportId·companyRunId 없음) 형식은 바꾸지 않는다.
  if (companyRunId && teamId === GOV_COMMAND_INCIDENT_TEAM_ID) {
    if (prompt.includes(INCIDENT_COMMAND_RESPONSE_CONTRACT)) return prompt;
    return [
      prompt,
      '',
      INCIDENT_COMMAND_RESPONSE_CONTRACT,
      '- 영향범위·중단기준·복구책임·상황보고 주기를 실제로 선언·갱신했으면 첫 줄을 `done:`으로 시작한다.',
      '- T1(파일·DB row·HTTP 본문·명령 출력) 없이는 완료·복구·정상 판정을 주장하지 않는다.',
      '- 데이터·권한·도구 부족이면 첫 줄을 `status:`로 시작하고 `[미검증]`·다음 T1 수집 액션을 명시한다.',
      '- 실행 실패를 보고할 때는 첫 줄을 `error:`로 시작하고 실제 오류·task id·재현 조건을 기록한다.',
      '- 검증 가능한 성공 기준(명령·기대 출력·롤백 방법)과 bounded 되돌리기 경로를 반드시 포함한다.',
      '- 파괴적 조치(삭제·force-push·DROP)는 독립감사 2nd key 없이 제안·실행하지 않는다.',
    ].join('\n');
  }

  // gov-assurance-resilience HR 개선·회사 실행 태스크는 SLO·격리·상태신선도·복구를 보고하지만,
  // 주입 실데이터만으로 done:을 쓰면 T1(HTTP 본문·복구 실행) 없이 완료를 주장한다(실측 2026-07-30
  // team-runner: done: + 게이트웨이/WS/백업 미확인 동시 존재). 회사 실행(companyRunId)에만
  // 계약을 주입해 일일 업무보고(workReportId·companyRunId 없음) 형식은 바꾸지 않는다.
  if (companyRunId && teamId === GOV_ASSURANCE_RESILIENCE_TEAM_ID) {
    if (prompt.includes(RESILIENCE_REVIEW_RESPONSE_CONTRACT)) return prompt;
    return [
      prompt,
      '',
      RESILIENCE_REVIEW_RESPONSE_CONTRACT,
      '- SLO·장애격리·상태신선도·백업·RTO/RPO·롤백 판정을 실제로 검토·갱신했으면 첫 줄을 `done:`으로 시작한다.',
      '- T1(HTTP 응답 본문·DB row·파일·명령 출력) 없이는 가용·복구·정상·롤백 불필요 판정을 주장하지 않는다.',
      '- 데이터·권한·도구 부족이면 첫 줄을 `status:`로 시작하고 `[미검증]`·다음 T1 수집 액션(프로브 명령·기대 출력)을 명시한다.',
      '- 실행 실패를 보고할 때는 첫 줄을 `error:`로 시작하고 실제 오류·task id·재현 조건을 기록한다.',
      '- 에이전트 성공률·idle/working 불일치·대기 태스크는 교차검증 근거와 함께 기록하고, 수치만 반복하지 않는다.',
      '- 검증 가능한 성공 기준(명령·기대 출력·롤백 방법)과 bounded 되돌리기 경로를 반드시 포함한다.',
    ].join('\n');
  }

  // 팀 상시 임무인 "[업무보고 작성]" 일일 보고와 성과/목표 입력 태스크는 companyRunId 없이
  // 독립 스케줄러가 생성하며, 소스 발굴 dossier 계약과 무관하다. 이 계약을 주입하면
  // gateway.ts의 hasResponseContract()가 true가 되어 requireProtocolPrefix가 켜지고, 정상
  // "업무보고" 형식 응답(첫 줄이 done:/status:가 아님)이 FORMAT_MISMATCH로 반려된다
  // (실측 2026-07-27: task_oFksRs9zeIa0euYV, teamId=team_tech-port-01-source-discovery,
  // workReportId만 있고 companyRunId 없음, 응답 "**업무보고**..."가 반려됨).
  if (metadata?.teamId === SOURCE_DISCOVERY_TEAM_ID) {
    if (isWorkReportPrompt(prompt) || isPerformanceGoalInputPrompt(prompt)) return prompt;
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

  const targetsImprovementDebate = (typeof metadata?.teamId === 'string' && IMPROVEMENT_DEBATE_TEAM_IDS.has(metadata.teamId))
    || (typeof metadata?.diagnosticTargetTeamId === 'string' && IMPROVEMENT_DEBATE_TEAM_IDS.has(metadata.diagnosticTargetTeamId));
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

export function shouldApplyPromptGateForProvider(providerId?: string): boolean {
  return true;
}

export function applyPromptGate(prompt: string, metadata?: Record<string, unknown>): {
  prompt: string;
  promptGate: PromptGateInfo;
} {
  const readOnly = metadata?.readOnly === true || isReadOnlyTaskPrompt(prompt);
  const workReport = isWorkReportPrompt(prompt);
  const textOnly = isTextOnlyPrompt(prompt);
  const structuredOutput = isStructuredOutputPrompt(prompt);
  const performanceGoalInput = isPerformanceGoalInputPrompt(prompt);
  const isGovCommandIntake = typeof metadata?.teamId === 'string'
    && metadata.teamId === GOV_COMMAND_INTAKE_TEAM_ID;
  const isCompanyIntake = isGovCommandIntake
    && typeof metadata?.companyRunId === 'string'
    && metadata.companyRunId.trim().length > 0;
  const skipBuildVerification = readOnly
    || workReport
    || textOnly
    || structuredOutput
    || performanceGoalInput
    || isCompanyIntake
    || isGovCommandIntake;
  const outputFormat = readOnly
    ? READ_ONLY_OUTPUT_FORMAT
    : workReport
      ? '요구된 Markdown 업무보고 본문.'
      : structuredOutput
        ? '요구된 JSON 형식만 출력.'
        : textOnly
          ? '요구된 텍스트 본문만 출력.'
          : performanceGoalInput
            ? '요청된 목표·성과 입력 결과와 검증 근거 요약.'
            : isCompanyIntake || isGovCommandIntake
              ? '완료된 미션 접수·정규화 결과 요약과 검증 근거.'
              : undefined;
  // 실패한 업무보고의 자동 보강 프롬프트가 재시도 입력으로 재사용되면 score=100이라
  // 누락 필드 보강 분기를 건너뛴다. 사용자 작성 형식은 건드리지 않고 과거 자동 생성
  // 코드 작업 형식만 현재 태스크 유형에 맞게 교정한다.
  const outputNormalizedPrompt = outputFormat && prompt.includes(AUTO_CODE_OUTPUT_FORMAT)
    ? prompt.replace(
      AUTO_CODE_OUTPUT_FORMAT,
      `[출력형식] (자동 보강) ${outputFormat}`,
    )
    : prompt;
  const normalizedPrompt = readOnly
    ? outputNormalizedPrompt.replace(AUTO_CODE_VERIFICATION_PATTERN, READ_ONLY_VERIFICATION)
    : outputNormalizedPrompt;
  const analysis = analyzePrompt(normalizedPrompt);
  if (analysis.score < 60) {
    return {
      prompt: applyTeamResponseContract(
        enrichPrompt(normalizedPrompt, {
          projectDir: typeof metadata?.projectDir === 'string' ? metadata.projectDir : undefined,
          taskType: inferTaskType(prompt),
          outputFormat,
          skipBuildVerification,
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
    prompt: applyTeamResponseContract(normalizedPrompt, metadata),
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
  if (input.metadata?.readOnly === true || isReadOnlyTaskPrompt(input.prompt)) return undefined;
  if (isStructuredOutputPrompt(input.prompt)) return undefined;
  // 업무보고는 prompt-gate 보강문의 "수정/빌드" 때문에 코드 작업으로 오탐될 수 있다.
  // 자유형 Markdown 보고에는 기본 build verifier를 붙이지 않는다.
  if (isWorkReportPrompt(input.prompt)) return undefined;
  // 목표/성과 입력은 HTTP 제어면 작업이다. prompt-gate 보강문의 "수정/빌드"를 코드 작업으로
  // 오인하면 실제 POST 성공 여부와 무관한 build/format gate가 추가된다.
  if (isPerformanceGoalInputPrompt(input.prompt)) return undefined;
  // research-strategy company run은 prompt-gate 보강문의 "수정/빌드" 때문에 코드 작업으로
  // 오탐되어 build verifier가 붙고, 그게 requireProtocolPrefix=true를 활성화해 자유형
  // 연구 보고서를 FORMAT_MISMATCH로 반려한다 (실측 2026-07-24: company-orchestrator 부모
  // 3건, direct retry 8건). build verifier는 코드 산출물 검증용이므로 연구/기획 팀에는
  // 붙이지 않는다 — 품질 검증은 내용 기반(response-quality.ts)으로만 수행한다.
  const tid = typeof input.metadata?.teamId === 'string' ? input.metadata.teamId : '';
  if (RESEARCH_STRATEGY_TEAM_IDS.has(tid) || tid === SOURCE_DISCOVERY_TEAM_ID || tid === GOV_COMMAND_INTAKE_TEAM_ID) return undefined;
  if (!pathExists(resolve(projectDir, 'package.json'))) return undefined;

  return {
    type: 'run',
    command: 'npm run build',
    timeoutMs: 120_000,
  };
}

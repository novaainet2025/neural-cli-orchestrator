// 회사(organization) 단위 오케스트레이션 — 목표 1개를 소속 팀들의 역할에 맞게
// 분배(LLM 매니저 분해)하고 파이프라인(순차) 또는 병렬로 실행한다.
//
// 설계 근거(T1, 2026-07-22 claude-3):
//   - "회사" = organizations 테이블(팀은 organization_id 로 소속).
//   - 팀 = 역할: lead(실행 프로바이더)·charter(역할 헌장)·members 보유.
//   - 태스크 생성 = app.inject POST /api/task (202, {taskId,agentId}); team_id 는
//     라우트가 자동설정 안 하므로 UPDATE tasks SET team_id 로 명시 태그.
//   - LLM 동기 호출 = agentManager.executeTask(agentId, prompt) → {output,success}.
//   - 파이프라인 이전단계 산출물 = tasks.response 컬럼.
//   - 완료 대기 = tasks.status 폴링(터미널: completed/failed/timed_out/cancelled).
import type { FastifyInstance } from 'fastify';
import { getDb } from '../storage/database.js';
import { checkResponseQuality } from '../verification/response-quality.js';
import { agentManager } from '../agent/agent-manager.js';
import { createId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';
import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';
import { smartRouter } from './smart-router.js';
import { classifyTier, type Tier } from './tier-policy.js';
import type { TaskType } from './quality-gate.js';
import { acquireComputerUseLease } from './computer-use-company.js';
import { adaptiveScorer } from './adaptive-scorer.js';
import { hasResponseContract } from './response-contract.js';
import { listActivelyRateLimited } from './rate-limit-state.js';
import {
  buildProtocolSafeHandoff,
  parseCollaborationProtocol,
} from './collaboration.js';
import { discussionEngine } from './discussion-engine.js';
import {
  createWorkflowRun,
  evaluateWorkflowPolicy,
  markWorkflowStage,
  type WorkflowStage,
} from './workflow-gate.js';
// 프로바이더 가용성 판정: 등록되어 있고 서킷이 열려있지 않은(리밋/quota/실패로 차단 안 된) 것만 true.
// 리밋 걸린 프로바이더를 선택 단계에서 즉시 걸러 폴백이 지연 없이 이뤄지게 한다.
export type AvailabilityFn = (agentId: string) => boolean;
function liveAvailability(known: Set<string>): AvailabilityFn {
  // rate_limit_state 스냅샷을 호출당 1회만 읽어 lazy 캐시(핫패스 DB 왕복 방지).
  let limited: Set<string> | null = null;
  const getLimited = (): Set<string> => {
    if (limited) return limited;
    limited = new Set<string>();
    try {
      // is_limited=1 alone is not enough — expired reset_at must not permanently exclude.
      limited = listActivelyRateLimited(getDb());
    } catch { /* 테이블 없음/오류 → 리밋 정보 없이 진행 */ }
    return limited;
  };
  return (id: string) => {
    if (!known.has(id)) return false;
    if (getLimited().has(id)) return false; // 주간/일일 리밋 즉시 스킵
    try { return circuitBreakerRegistry.getAvailability(id).available; }
    catch { return true; } // 판정 불가 시 보수적으로 시도 허용
  };
}

const log = createLogger('company-orchestrator');

export type OrchestrationMode = 'pipeline' | 'parallel';
export type RunStatus =
  | 'pending' | 'decomposing' | 'planned' | 'dispatching' | 'running'
  | 'dispatched' | 'completed' | 'failed' | 'partial' | 'cancelled';
export type StageStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'skipped';

export interface TeamRow {
  id: string;
  name: string;
  slug: string;
  lead: string | null;
  charter: string | null;
  description: string | null;
  members: string[]; // member_ref 목록(provider/session ref)
}

export interface RunStage {
  teamId: string;
  teamSlug: string;
  teamName: string;
  rank: number;
  executor: string;      // 실제 dispatch 대상(=lead|member|fallback, failover 후 갱신)
  subtask: string | null;
  taskId: string | null;
  status: StageStatus;
  outputSnippet?: string;
  error?: string;
  executorNote?: string;   // lead 미등록/폴백 등 배정 경고(가시화)
  outputChars?: number;    // 산출물 길이(빈 산출물 진단)
  attempt?: number;        // 순차 failover: 몇 번째 후보에서 처리됐는지
  retryCount?: number;     // 병렬 재시도 횟수(0=재시도 없음)
}

export interface CompanyRun {
  id: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  goal: string;
  mode: OrchestrationMode;
  status: RunStatus;
  dryRun: boolean;
  projectDir: string;
  maxIterations: number;
  completedIterations: number;
  resumeCount: number;
  createdAt: string;
  updatedAt: string;
  decomposer: string | null;   // 분해 담당 LLM(실제 사용된 agent)
  decomposeSource: 'llm' | 'template' | null;
  workflowRunId?: string | null;
  stages: RunStage[];
  summary?: { total: number; succeeded: number; failed: number; retried: number; skipped?: number };
  iteration?: number;   // 루프 앤진: 몇 번째 완료-루프 반복인지(1부터)
  error?: string;
  portDecision?: 'approve' | 'reject' | 'undetermined';
  computerUse?: {
    provider: 'codex';
    status: 'waiting' | 'activating' | 'active' | 'releasing' | 'released' | 'failed';
    message: string;
    queuedBehindRunId?: string;
    activatedAt?: string;
    releasedAt?: string;
  };
}

export function decideCompanyRunResume(input: {
  incomplete: boolean;
  resumeCount: number;
  completedIterations: number;
  maxIterations: number;
  maxResumes?: number;
}): 'complete' | 'continue' | 'recovery_budget_exhausted' | 'iteration_budget_exhausted' {
  if (!input.incomplete) return 'complete';
  if (input.resumeCount > (input.maxResumes ?? 3)) return 'recovery_budget_exhausted';
  if (input.completedIterations >= input.maxIterations) return 'iteration_budget_exhausted';
  return 'continue';
}

// ── 순수 유틸(테스트 대상) ─────────────────────────────────────────────

// 팀을 파이프라인 단계 순서로 정렬하기 위한 역할 랭크.
// slug/name/charter/description 를 키워드로 매칭. 매칭 없으면 큰 값(생성순 유지).
const STAGE_KEYWORDS: Array<[number, RegExp]> = [
  [1, /strateg|plan(?!t)|기획|전략|design|설계|architect|아키텍/i],
  // 주의: bare "research"/"리서치"는 조직 slug 접두사(research-*)와 충돌하므로 제외.
  // discovery 단계는 탐색·수집 계열 어휘로만 매칭한다.
  [2, /discover|수집|탐색|collect|gather|scout/i],
  [3, /impl|core|dev(?!ops)|개발|build|구현|코어|coding/i],
  [4, /analy|분석|추론|reason|insight/i],
  [5, /verif|\bqa\b|test|검증|팩트|fact|review|리뷰|품질|audit|검수|quality/i],
  [6, /writ|report|집필|리포|docs|문서|정리/i],
  [7, /viz|visual|media|시각|미디어|graphic|render/i],
];

export const NCO_COMMAND_STAGE_SLUGS = [
  'gov-command-strategic',
  'gov-command-intake',
  'gov-command-routing',
  'gov-command-collaboration',
  'gov-command-incident',
] as const;

export const NCO_EVOLUTION_STAGE_SLUGS = [
  'gov-evolution-learning',
  'gov-evolution-memory',
  'gov-evolution-evaluation',
  'gov-evolution-improvement',
  'gov-evolution-skills',
] as const;

export const NCO_ENGINEERING_STAGE_SLUGS = [
  'gov-engineering-experts',
  'gov-engineering-architecture',
  'gov-engineering-build',
  'gov-engineering-release',
  'gov-engineering-reliability',
] as const;

export const NCO_ASSURANCE_STAGE_SLUGS = [
  'gov-assurance-safety',
  'gov-assurance-redteam',
  'gov-assurance-verification',
  'gov-assurance-resilience',
  'gov-assurance-audit',
] as const;

export const NCO_GOVERNMENT_STAGE_SLUGS = [
  'gov-government-constitution',
  'gov-government-rights',
  'gov-government-hr',
  'gov-government-treasury',
  'gov-government-transparency',
] as const;

export interface NcoFoundationCompanyPolicy {
  manager: string;
  slugs: readonly string[];
  name: string;
}

export const NCO_FOUNDATION_COMPANY_POLICIES: Readonly<Record<string, NcoFoundationCompanyPolicy>> = {
  'nco-command': { manager: 'claude-code', slugs: NCO_COMMAND_STAGE_SLUGS, name: '지휘' },
  'nco-evolution': { manager: 'opencode', slugs: NCO_EVOLUTION_STAGE_SLUGS, name: '학습·진화' },
  'nco-engineering': { manager: 'codex', slugs: NCO_ENGINEERING_STAGE_SLUGS, name: '전문기술' },
  'nco-assurance': { manager: 'cursor-agent', slugs: NCO_ASSURANCE_STAGE_SLUGS, name: '독립검증·안전' },
  'nco-government': { manager: 'nvidia', slugs: NCO_GOVERNMENT_STAGE_SLUGS, name: '헌정·행정' },
};

const NCO_FOUNDATION_STAGE_RANKS = new Map<string, number>(
  Object.values(NCO_FOUNDATION_COMPANY_POLICIES).flatMap((policy) =>
    policy.slugs.map((slug, index) => [slug, index + 1] as const),
  ),
);

export function rankTeam(team: TeamRow): number {
  // 기술 이식·웹 스크래핑 회사는 안전 게이트가 포함된 고정 순서가
  // 역할 키워드보다 중요하다. 전용 slug 번호를 명시적 stage rank로 사용한다.
  const controlledStage = team.slug.match(/^(?:tech-port|web-scrape)-(\d{2})-/);
  if (controlledStage) return Number(controlledStage[1]);

  const foundationStage = NCO_FOUNDATION_STAGE_RANKS.get(team.slug);
  if (foundationStage !== undefined) return foundationStage;

  // 랭킹은 slug+name(깨끗한 단일 역할 토큰)만 사용한다.
  // charter/description 은 "탐색수집팀 핸드오프"·"수집자료→분석" 처럼 타 단계 어휘가
  // 섞여 있어 순서를 오염시키므로 제외한다(그 텍스트는 LLM 분해 프롬프트에서만 사용).
  const hay = `${team.slug} ${team.name}`;
  for (const [rank, re] of STAGE_KEYWORDS) {
    if (re.test(hay)) return rank;
  }
  return 99;
}

// 파이프라인 순서로 팀 정렬(안정 정렬: 랭크 동률이면 원래 순서 유지).
export function orderTeams(teams: TeamRow[]): TeamRow[] {
  return teams
    .map((t, i) => ({ t, i, r: rankTeam(t) }))
    .sort((a, b) => (a.r - b.r) || (a.i - b.i))
    .map((x) => x.t);
}

const EVOLUTION_LEARNING_LOCAL_RECOVERY_DISABLED = new Set(['0', 'false', 'off']);

// Continuous Learning은 provider queue/session/auth 장애 자체를 학습해야 하므로,
// 원격 provider를 연속으로 거친 뒤에야 로컬 복구자를 시도하면 같은 장애 표본을
// 중복 생성한다. lead 우선순위는 유지하되, 팀에 명시적으로 등록된 ollama만 첫
// 복구 member로 올린다. 다른 팀과 미등록 외부 provider에는 영향이 없다.
// 런타임 롤백: NCO_EVOLUTION_LEARNING_LOCAL_RECOVERY=off.
export function orderRecoveryMembers(
  team: Pick<TeamRow, 'slug' | 'members'>,
  toggle = process.env.NCO_EVOLUTION_LEARNING_LOCAL_RECOVERY,
): string[] {
  const disabled = EVOLUTION_LEARNING_LOCAL_RECOVERY_DISABLED.has(
    toggle?.trim().toLowerCase() ?? '',
  );
  if (
    disabled
    || team.slug !== 'gov-evolution-learning'
    || !team.members.includes('ollama')
  ) {
    return team.members;
  }
  return ['ollama', ...team.members.filter((member) => member !== 'ollama')];
}

// 팀의 실행자 해석: (가용한) lead → (가용한) 첫 member → fallback.
// isAvailable 미지정 시 "등록 여부"만 본다(테스트 호환). 지정 시 리밋/차단된 provider 제외.
export function resolveExecutor(
  team: TeamRow,
  knownAgents: Set<string>,
  fallback = 'ollama',
  isAvailable: AvailabilityFn = (id) => knownAgents.has(id),
): string {
  const members = orderRecoveryMembers(team);
  if (team.lead && isAvailable(team.lead)) return team.lead;
  const m = members.find((ref) => isAvailable(ref));
  if (m) return m;
  if (isAvailable(fallback)) return fallback;
  // 전원 차단 시: 등록된 lead/멤버라도 반환(디스패치는 /api/task failover 가 재시도).
  if (team.lead && knownAgents.has(team.lead)) return team.lead;
  const km = members.find((ref) => knownAgents.has(ref));
  return km ?? team.lead ?? fallback;
}

// 단계 failover용 실행자 후보 체인(우선순위·중복제거·순서유지).
// 1순위: 가용한 lead → 가용한 member(선언순) → 가용한 fallback.
// 2순위: (전원 리밋 대비) 등록됐지만 불가용일 수 있는 lead/member/fallback.
// resolveExecutorChain(...)[0] 은 resolveExecutor(...) 와 동일 실행자를 낸다.
export function resolveExecutorChain(
  team: TeamRow,
  knownAgents: Set<string>,
  fallback = 'ollama',
  isAvailable: AvailabilityFn = (id) => knownAgents.has(id),
): string[] {
  const chain: string[] = [];
  const push = (id: string | null | undefined) => {
    if (id && knownAgents.has(id) && !chain.includes(id)) chain.push(id);
  };
  const members = orderRecoveryMembers(team);
  if (team.lead && isAvailable(team.lead)) push(team.lead);
  for (const ref of members) if (isAvailable(ref)) push(ref);
  if (isAvailable(fallback)) push(fallback);
  push(team.lead);
  for (const ref of members) push(ref);
  push(fallback);
  return chain;
}

// TaskType별 역량 우선순위 — 현재 가용 프로바이더만 역량 내림차순으로 나열.
const CAPABILITY_CANDIDATES: Record<TaskType, string[]> = {
  design:   ['opencode', 'claude-code', 'codex', 'agy', 'nvidia'],
  code:     ['codex', 'opencode', 'hermes', 'cursor-agent', 'ollama'],
  review:   ['cursor-agent', 'codex', 'opencode', 'nvidia', 'ollama'],
  verify:   ['ollama', 'hermes', 'nvidia', 'codex', 'cursor-agent'],
  research: ['nvidia', 'hermes', 'opencode', 'ollama', 'codex'],
  ui:       ['agy', 'opencode', 'codex', 'cursor-agent'],
  media:    ['agy', 'opencode', 'codex'],
  general:  ['codex', 'opencode', 'claude-code', 'hermes', 'ollama'],
};

export function selectCapabilityExecutor(
  subtask: string,
  knownAgents: Set<string>,
  fallback = 'ollama',
  isAvailable: AvailabilityFn = (id) => knownAgents.has(id),
): { executor: string; taskType: TaskType; complexity: number; tier: Tier } {
  const taskType = smartRouter.inferTaskType(subtask);
  const complexity = smartRouter.analyzeComplexity(subtask);
  const tier = classifyTier(subtask, complexity);
  const registered = (CAPABILITY_CANDIDATES[taskType] ?? CAPABILITY_CANDIDATES.general)
    .filter((id) => knownAgents.has(id));
  const liveCandidates = registered.filter((id) => isAvailable(id));
  const weights = adaptiveScorer.getWeightsForTask(liveCandidates, taskType);
  // Capability order remains the role contract; adaptive telemetry may
  // re-rank nearby candidates but cannot let raw speed erase a large domain
  // mismatch (for example, AGY operational latency outranking an architect
  // for a non-UI architecture task).
  const live = [...liveCandidates].sort((a, b) => {
    const aScore = (weights[a] ?? 1) - registered.indexOf(a) * 0.2;
    const bScore = (weights[b] ?? 1) - registered.indexOf(b) * 0.2;
    return bScore - aScore;
  })[0];
  if (live) return { executor: live, taskType, complexity, tier };
  if (registered.length) return { executor: registered[0], taskType, complexity, tier };
  const fb = (isAvailable(fallback) || knownAgents.has(fallback))
    ? fallback
    : ([...knownAgents][0] ?? fallback);
  return { executor: fb, taskType, complexity, tier };
}

export function reselectExecutor(
  team: TeamRow,
  subtask: string,
  knownAgents: Set<string>,
  fallback = 'ollama',
  isAvailable: AvailabilityFn = (id) => knownAgents.has(id),
): { executor: string; taskType: TaskType; note?: string } {
  if (team.lead && knownAgents.has(team.lead) && isAvailable(team.lead)) {
    return { executor: team.lead, taskType: smartRouter.inferTaskType(subtask) };
  }
  const cap = selectCapabilityExecutor(subtask, knownAgents, fallback, isAvailable);
  const reason = !team.lead ? 'lead 미지정'
    : !knownAgents.has(team.lead) ? `lead '${team.lead}' 제거/미등록`
    : `lead '${team.lead}' 서킷 open/불가용`;
  const note = `${reason} → 역량매칭(${cap.taskType}) '${cap.executor}' 재선정`;
  return { executor: cap.executor, taskType: cap.taskType, note };
}

export function selectCompanyStageExecutor(
  orgSlug: string,
  team: TeamRow,
  subtask: string,
  knownAgents: Set<string>,
  isAvailable: AvailabilityFn = (id) => knownAgents.has(id),
): { executor: string; taskType: TaskType; note?: string } {
  if (allowQueueProviderFailover(orgSlug)) {
    return reselectExecutor(team, subtask, knownAgents, 'ollama', isAvailable);
  }
  const executor = resolveExecutor(team, knownAgents, '', isAvailable);
  const taskType = smartRouter.inferTaskType(subtask);
  if (executor === team.lead) return { executor, taskType };
  return {
    executor,
    taskType,
    note: `헌정/안전 회사 team-only 정책 → 등록 팀원 '${executor}' 재선정`,
  };
}

// 분해 담당 LLM 후보(우선순위 순). 앞에서부터 시도해 처음으로 파싱가능 JSON 을
// 내는 프로바이더를 채택한다(프로바이더 서킷트립·CLI실패에 견디도록 체인화).
// 순서: org.manager 토큰(등록 시) → 설계/구조에 강한 provider → 로컬 폴백.
const DECOMPOSER_PREFS = ['opencode', 'claude-code', 'nvidia', 'codex', 'ollama'];

export function resolveDecomposers(
  orgManager: string | null,
  knownAgents: Set<string>,
  isAvailable: AvailabilityFn = (id) => knownAgents.has(id),
): string[] {
  const out: string[] = [];
  if (orgManager) {
    const token = orgManager.trim().split(/[\s(]/)[0];
    if (token && isAvailable(token)) out.push(token);
  }
  for (const pref of DECOMPOSER_PREFS) {
    if (isAvailable(pref) && !out.includes(pref)) out.push(pref);
  }
  if (out.length === 0) {
    // 가용 후보가 하나도 없으면(전원 리밋) 등록된 것 중 하나라도 시도용으로.
    const anyKnown = [...knownAgents].find((id) => !out.includes(id));
    if (anyKnown) out.push(anyKnown);
  }
  return out;
}

// 헌정 5개 회사의 분해 권한은 창설 계약의 manager에게만 있다.
// 지정 manager가 불가용하면 다른 회사의 manager가 지휘권을 대행하지 않고,
// 빈 후보를 반환해 driveRunBody의 결정론적 template 분해로 fail-closed 한다.
export function resolveCompanyDecomposers(
  orgSlug: string,
  orgManager: string | null,
  knownAgents: Set<string>,
  isAvailable: AvailabilityFn = (id) => knownAgents.has(id),
): string[] {
  const policy = NCO_FOUNDATION_COMPANY_POLICIES[orgSlug];
  if (!policy) return resolveDecomposers(orgManager, knownAgents, isAvailable);
  return knownAgents.has(policy.manager) && isAvailable(policy.manager)
    ? [policy.manager]
    : [];
}

// 하위호환/단일선택용 — 후보 중 첫 번째.
export function resolveDecomposer(orgManager: string | null, knownAgents: Set<string>): string | null {
  return resolveDecomposers(orgManager, knownAgents)[0] ?? null;
}

// LLM 분해 프롬프트 — 팀별 slug→하위작업(한 문단) JSON 만 출력하도록 지시.
export function buildDecompositionPrompt(orgName: string, goal: string, teams: TeamRow[]): string {
  const lines = teams.map((t) => {
    const role = t.charter || t.description || '(역할 미정의)';
    return `- slug: "${t.slug}" | 팀명: ${t.name} | 역할: ${role} | lead: ${t.lead ?? '미지정'}`;
  }).join('\n');
  return [
    `당신은 회사 "${orgName}"의 오케스트레이터입니다. 아래 회사 목표를 각 팀의 역할(charter)에 맞는 구체적 하위작업으로 분배하세요.`,
    ``,
    `[회사 목표]`,
    goal,
    ``,
    `[소속 팀]`,
    lines,
    ``,
    `[출력 규칙 — 반드시 준수]`,
    `1. 오직 JSON 객체 하나만 출력. 코드펜스·설명·주석 금지.`,
    `2. 키는 위 팀의 slug, 값은 그 팀이 자기 역할 관점에서 수행할 구체적 하위작업(한국어 1문단).`,
    `3. 모든 팀 slug 를 빠짐없이 포함. 목표와 무관한 팀은 "이 목표에서 제외" 로 명시.`,
    `4. 각 하위작업은 실행 가능하도록 무엇을·왜·산출물 형식을 포함.`,
    ``,
    `예: {"team-a":"...", "team-b":"..."}`,
  ].join('\n');
}

// LLM 출력에서 JSON 분해 결과 파싱(코드펜스 제거 + 첫 균형중괄호 추출). 실패 시 null.
export function parseDecomposition(raw: string, teams: TeamRow[]): Record<string, string> | null {
  if (!raw) return null;
  let text = raw.trim();
  // ```json ... ``` 펜스 제거
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // 첫 '{' 부터 균형 맞는 '}' 까지 추출
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  let obj: unknown;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const validSlugs = new Set(teams.map((t) => t.slug));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (validSlugs.has(k) && typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function parsePortDecision(raw: string | null | undefined): 'approve' | 'reject' | 'undetermined' {
  if (!raw) return 'undetermined';
  const decisions = [...raw.matchAll(/^\s*PORT_DECISION\s*:\s*(APPROVE|REJECT)\s*$/gim)]
    .map((match) => match[1].toLowerCase() as 'approve' | 'reject');
  const unique = [...new Set(decisions)];
  return unique.length === 1 ? unique[0] : 'undetermined';
}

// 산출물이 "실질 내용"인지 판정 — 파이프라인 하류 환각 캐스케이드 방지 게이트.
// 실패 사례: 수집팀(ollama)이 "done: [Evidence Tier 1] verified"(45자)만 내고 실제 수집 0건 →
// 하류(분석·집필)가 데이터 없이 로컬파일 붙잡고 환각. 이런 빈 산출물을 조기 차단한다.
const MIN_SUBSTANTIVE_CHARS = 200;
export function isSubstantiveOutput(response: string | null | undefined): boolean {
  if (!response) return false;
  // 프로토콜 서두("done:"/"status:"/"[Evidence Tier N] ... verified") 제거 후 실질 길이 측정
  let text = response.trim();
  text = text.replace(/^(done|status|answer)\s*:.*$/im, '');
  text = text.replace(/\[Evidence Tier \d\][^\n]*/gi, '');
  text = text.replace(/(file|content|command output)\s+verified/gi, '');
  return text.trim().length >= MIN_SUBSTANTIVE_CHARS;
}

export function isCompanyStageOutputAcceptable(
  response: string | null | undefined,
  options: { isLastStage: boolean; requireProtocolPrefix: boolean },
): boolean {
  const quality = checkResponseQuality(response ?? '', {
    requireProtocolPrefix: options.requireProtocolPrefix,
    rejectToolEchoes: true,
  });
  if (!quality.pass) return false;
  const protocol = parseCollaborationProtocol(response);
  if (protocol && protocol.kind !== 'done') return false;
  return options.isLastStage || isSubstantiveOutput(response);
}

// 분해 실패/미매칭 팀용 결정론적 템플릿.
export function templateSubtask(team: TeamRow, goal: string): string {
  const role = team.charter || team.description;
  return [
    `[회사 목표] ${goal}`,
    ``,
    `당신은 '${team.name}' 팀입니다${role ? ` (역할: ${role})` : ''}.`,
    `이 역할 관점에서 위 목표를 수행하고, 무엇을 했는지·산출물을 명확히 보고하세요.`,
  ].join('\n');
}

// LLM 분해 결과도 반드시 원래 회사 목표 아래에 둔다.
// 분해기가 팀 헌장만 되풀이하거나 핵심 대상을 누락해도 실행자가 목표 범위를 잃지 않게 한다.
export function scopeDecomposedSubtask(team: TeamRow, goal: string, decomposed?: string): string {
  const specific = decomposed?.trim();
  const scoped = specific
    ? [
        `[회사 목표] ${goal}`,
        ``,
        `[팀 하위작업: ${team.name}]`,
        specific,
        ``,
        `위 하위작업은 회사 목표의 대상·안전 제약·산출물 경로를 그대로 준수해야 합니다.`,
      ].join('\n')
    : templateSubtask(team, goal);
  if (team.slug !== 'tech-port-07-value-gate-report') return scoped;
  return [
    scoped,
    ``,
    `[필수 단일결정 출력 계약]`,
    `응답 첫 줄에 PORT_DECISION: APPROVE 또는 PORT_DECISION: REJECT 중 판단한 한 줄만 쓰세요.`,
    `선택하지 않은 결정 문자열은 예시·설명·기본값 문맥을 포함해 응답의 다른 어느 곳에도 쓰지 마세요.`,
    `두 결정이 함께 있거나 첫 줄에 단일 결정이 없으면 이 단계는 자동 실패합니다.`,
  ].join('\n');
}

// Upgrade Regression 실측 태스크에서 이전 단계 출력이 프롬프트 맨 앞에 그대로 붙자
// 실행자가 현재 단계 대신 상류의 도구 설명/본문을 되풀이했고, verifier가 붙은 두 응답이
// FORMAT_MISMATCH로 반려됐다(task_RSYX40DOFx91XC4G, task_8nOuGiIxyz6yoKxq).
// 이 단계에만 입력 경계와 응답 계약을 추가해 다른 회사/단계의 프롬프트를 바꾸지 않는다.
export function buildPipelineHandoffSubtask(
  teamSlug: string,
  currentSubtask: string,
  previousTeamName?: string,
  previousOutput?: string,
): string {
  if (!previousTeamName || !previousOutput) return currentSubtask;
  const handoff = buildProtocolSafeHandoff({
    currentSubtask,
    previousTeamName,
    previousOutput,
  });
  if (teamSlug !== 'tech-port-05-upgrade-regression') return handoff;

  return [
    handoff,
    ``,
    `[05 Upgrade Regression 응답 계약]`,
    `- 이전 단계 산출물이나 도구 함수 설명을 그대로 반복하는 것으로 현재 작업을 대신하지 마세요.`,
    `- 격리 프로토타입과 기준선의 A/B 비교값, 실행 명령, 실패·회귀 사례를 현재 단계 산출물로 보고하세요.`,
    `- 필수 비교를 실제로 완료했으면 첫 줄을 "done:"으로, 자료 부족·실행 불가이면 "status:"로 시작하세요.`,
    `- 직접 측정하지 않은 수치나 완료 상태를 만들지 마세요.`,
  ].join('\n');
}

// 안전 게이트 회사는 팀 밖의 범용/저신뢰 executor로 재위임하지 않는다.
// 단계별 failover는 runStageWithFailover가 조직에 등록된 팀원 체인 안에서 수행한다.
export function allowQueueProviderFailover(orgSlug: string): boolean {
  const normalizedSlug = orgSlug.startsWith('org_') ? orgSlug.slice(4) : orgSlug;
  return normalizedSlug !== 'technology-porting'
    && normalizedSlug !== 'web-scraping'
    && NCO_FOUNDATION_COMPANY_POLICIES[normalizedSlug] === undefined;
}

function isDeclaredTeamExecutor(team: TeamRow, executor: string): boolean {
  return executor === team.lead || team.members.includes(executor);
}

// ── 실행 상태 저장소(인메모리, LRU 상한) ───────────────────────────────
const RUNS = new Map<string, CompanyRun>();
const MAX_RUNS = 200;
const ACTIVE_RUN_DRIVERS = new Set<string>();
const NON_TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'pending', 'decomposing', 'dispatching', 'running', 'dispatched',
]);

function persistRun(run: CompanyRun): boolean {
  try {
    getDb().prepare(`
      INSERT INTO company_runs
        (id, org_id, org_slug, goal, mode, status, dry_run, project_dir,
         run_json, created_at, updated_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,
        run_json=excluded.run_json,
        updated_at=excluded.updated_at,
        finished_at=excluded.finished_at
    `).run(
      run.id,
      run.orgId,
      run.orgSlug,
      run.goal,
      run.mode,
      run.status,
      run.dryRun ? 1 : 0,
      run.projectDir,
      JSON.stringify(run),
      run.createdAt,
      run.updatedAt,
      NON_TERMINAL_RUN_STATUSES.has(run.status) ? null : run.updatedAt,
    );
    return true;
  } catch (error) {
    log.error({
      runId: run.id,
      error: error instanceof Error ? error.message : String(error),
    }, 'Company run persistence failed; durability guarantee is degraded');
    return false;
  }
}

function parsePersistedRun(value: string): CompanyRun | null {
  try {
    const parsed = JSON.parse(value) as CompanyRun;
    if (!parsed?.id || !Array.isArray(parsed.stages)) return null;
    parsed.projectDir ||= process.cwd();
    parsed.maxIterations = Math.min(
      ABSOLUTE_MAX_RUN_ITERATIONS,
      Math.max(1, parsed.maxIterations ?? MAX_RUN_ITERATIONS),
    );
    parsed.completedIterations = Math.max(0, parsed.completedIterations ?? 0);
    parsed.resumeCount = Math.max(0, parsed.resumeCount ?? 0);
    parsed.workflowRunId ??= null;
    return parsed;
  } catch {
    return null;
  }
}

function putRun(run: CompanyRun, requirePersistence = false): void {
  RUNS.set(run.id, run);
  const persisted = persistRun(run);
  if (requirePersistence && !persisted) {
    RUNS.delete(run.id);
    throw new OrchestrationError(
      503,
      `company run persistence unavailable: ${run.id}`,
    );
  }
  while (RUNS.size > MAX_RUNS) {
    const oldest = RUNS.keys().next().value;
    if (oldest === undefined) break;
    RUNS.delete(oldest);
  }
}

export function getCompanyRun(runId: string): CompanyRun | null {
  const cached = RUNS.get(runId);
  if (cached) return cached;
  try {
    const row = getDb().prepare(
      'SELECT run_json FROM company_runs WHERE id=?'
    ).get(runId) as { run_json: string } | undefined;
    const run = row ? parsePersistedRun(row.run_json) : null;
    if (run) putRun(run);
    return run;
  } catch {
    return null;
  }
}

const ACTIVE_STAGE_FOR_CANCEL = new Set<StageStatus>(['pending', 'running']);
const TERMINAL_RUN_FOR_CANCEL = new Set<RunStatus>([
  'completed', 'failed', 'partial', 'cancelled', 'planned',
]);

/** True when the run driver must stop dispatching further work. */
export function isCompanyRunCancelled(run: CompanyRun): boolean {
  return run.status === 'cancelled';
}

/**
 * Mark a company run cancelled and cancel any active stage tasks
 * via POST /api/tasks/:id/cancel. Missing run → { ok:false, error:'run not found' }.
 * Already-terminal runs are left unchanged (idempotent ack).
 */
export async function cancelCompanyRun(
  app: FastifyInstance,
  runId: string,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const run = getCompanyRun(runId);
  if (!run) return { ok: false, error: 'run not found' };
  if (TERMINAL_RUN_FOR_CANCEL.has(run.status)) {
    return { ok: true, status: run.status };
  }

  const taskIds: string[] = [];
  for (const stage of run.stages) {
    if (!ACTIVE_STAGE_FOR_CANCEL.has(stage.status)) continue;
    if (stage.taskId) taskIds.push(stage.taskId);
    stage.status = 'cancelled';
    stage.error = stage.error ?? 'run cancelled';
  }

  run.status = 'cancelled';
  run.error = run.error ?? 'cancelled by request';
  touch(run);

  for (const taskId of taskIds) {
    try {
      await app.inject({
        method: 'POST',
        url: `/api/tasks/${encodeURIComponent(taskId)}/cancel`,
      });
    } catch (err) {
      log.warn({
        runId,
        taskId,
        err: err instanceof Error ? err.message : String(err),
      }, 'company run cancel: task cancel inject failed');
    }
  }

  return { ok: true, status: 'cancelled' };
}

/** Test helper: seed an in-memory company run (persistence best-effort). */
export function seedCompanyRunForTest(run: CompanyRun): void {
  putRun(run);
}

export function listCompanyRuns(limit = 20): CompanyRun[] {
  try {
    const rows = getDb().prepare(
      'SELECT run_json FROM company_runs ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as Array<{ run_json: string }>;
    return rows.map((row) => parsePersistedRun(row.run_json)).filter((run): run is CompanyRun => Boolean(run));
  } catch {
    return [...RUNS.values()].slice(-limit).reverse();
  }
}

function touch(run: CompanyRun): void {
  run.updatedAt = new Date().toISOString();
  putRun(run, true);
}


// ── DB 로더 ─────────────────────────────────────────────────────────────
export class OrchestrationError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

function loadOrg(idOrSlug: string): { id: string; name: string; slug: string; manager: string | null } {
  const db = getDb();
  const row = db.prepare(
    `SELECT id, name, slug, manager FROM organizations WHERE id=? OR slug=? LIMIT 1`
  ).get(idOrSlug, idOrSlug) as { id: string; name: string; slug: string; manager: string | null } | undefined;
  if (!row) throw new OrchestrationError(404, `organization not found: ${idOrSlug}`);
  return row;
}

function loadTeams(orgId: string): TeamRow[] {
  const db = getDb();
  const teams = db.prepare(
    `SELECT id, name, slug, lead, charter, description FROM teams
     WHERE organization_id=? AND is_active=1
     ORDER BY created_at ASC, name ASC`
  ).all(orgId) as Array<{ id: string; name: string; slug: string; lead: string | null; charter: string | null; description: string | null }>;
  const memberRows = db.prepare(
    `SELECT team_id, member_ref FROM team_members ORDER BY created_at ASC, id ASC`
  ).all() as Array<{ team_id: string; member_ref: string }>;
  const byTeam = new Map<string, string[]>();
  for (const r of memberRows) {
    const list = byTeam.get(r.team_id) ?? [];
    list.push(r.member_ref);
    byTeam.set(r.team_id, list);
  }
  return teams.map((t) => ({ ...t, members: byTeam.get(t.id) ?? [] }));
}

// ── 오케스트레이션 진입점 ───────────────────────────────────────────────
export interface StartRunOptions {
  orgIdOrSlug: string;
  goal: string;
  mode?: OrchestrationMode;
  projectDir: string;
  dryRun?: boolean;
  maxIterations?: number;
}

const TECHNOLOGY_PORT_STAGE_SLUGS = [
  'tech-port-01-source-discovery',
  'tech-port-02-safety-license',
  'tech-port-03-recovery-checkpoint',
  'tech-port-04-baseline-benchmark',
  'tech-port-05-upgrade-regression',
  'tech-port-06-improvement-debate',
  'tech-port-07-value-gate-report',
  'tech-port-08-migration-implementation',
  'tech-port-09-post-migration-verify',
] as const;

const WEB_SCRAPING_STAGE_SLUGS = [
  'web-scrape-01-intake-strategy',
  'web-scrape-02-source-discovery',
  'web-scrape-03-static-implementation',
  'web-scrape-04-dynamic-implementation',
  'web-scrape-05-data-analysis',
  'web-scrape-06-verification-quality',
  'web-scrape-07-report-delivery',
] as const;

export function validateCompanyPolicy(org: { slug: string; manager: string | null }, mode: OrchestrationMode, rawTeams: TeamRow[]): void {
  if (org.slug === 'computer-use') {
    const controlTeam = rawTeams.find((team) => team.slug === 'computer-use-control');
    if (
      org.manager !== 'codex'
      || !controlTeam
      || controlTeam.lead !== 'codex'
      || controlTeam.members.length !== 1
      || controlTeam.members[0] !== 'codex'
    ) {
      throw new OrchestrationError(
        409,
        'Computer Use 회사 안전정책 위반: manager와 computer-use-control 팀의 유일한 lead/member는 codex여야 합니다',
      );
    }
  }
  if (org.slug === 'technology-porting') {
    if (mode !== 'pipeline') {
      throw new OrchestrationError(400, '기술 이식 회사는 안전 게이트를 위해 pipeline 모드만 허용합니다');
    }
    const activeSlugs = new Set(rawTeams.map((team) => team.slug));
    const missing = TECHNOLOGY_PORT_STAGE_SLUGS.filter((slug) => !activeSlugs.has(slug));
    if (org.manager !== 'codex' || missing.length > 0) {
      throw new OrchestrationError(
        409,
        `기술 이식 회사 안전정책 위반: manager=codex 및 9개 필수 팀이 필요합니다${missing.length ? ` (누락: ${missing.join(', ')})` : ''}`,
      );
    }
  }
  if (org.slug === 'web-scraping') {
    if (mode !== 'pipeline') {
      throw new OrchestrationError(400, '웹 스크래핑 회사는 승인·범위 게이트를 위해 pipeline 모드만 허용합니다');
    }
    const activeSlugs = new Set(rawTeams.map((team) => team.slug));
    const missing = WEB_SCRAPING_STAGE_SLUGS.filter((slug) => !activeSlugs.has(slug));
    if (org.manager !== 'codex' || missing.length > 0) {
      throw new OrchestrationError(
        409,
        `웹 스크래핑 회사 안전정책 위반: manager=codex 및 7개 필수 팀이 필요합니다${missing.length ? ` (누락: ${missing.join(', ')})` : ''}`,
      );
    }
  }

  const govPolicy = NCO_FOUNDATION_COMPANY_POLICIES[org.slug];
  if (govPolicy) {
    if (mode !== 'pipeline') {
      throw new OrchestrationError(400, `NCO AI 정부 ${govPolicy.name} 회사는 권력분립과 안전 게이트를 위해 pipeline 모드만 허용합니다`);
    }
    const activeSlugs = new Set(rawTeams.map((team) => team.slug));
    const missing = govPolicy.slugs.filter((slug) => !activeSlugs.has(slug));
    const unexpected = [...activeSlugs].filter((slug) => !govPolicy.slugs.includes(slug));
    if (org.manager !== govPolicy.manager || missing.length > 0 || unexpected.length > 0) {
      const teamMismatch = [
        missing.length ? `누락: ${missing.join(', ')}` : '',
        unexpected.length ? `미승인: ${unexpected.join(', ')}` : '',
      ].filter(Boolean).join(' / ');
      throw new OrchestrationError(
        409,
        `NCO AI 정부 ${govPolicy.name} 회사 안전정책 위반: manager=${govPolicy.manager} 및 승인된 5개 활성 팀이 정확히 필요합니다${teamMismatch ? ` (${teamMismatch})` : ''}`,
      );
    }
  }
}

export function startCompanyRun(app: FastifyInstance, opts: StartRunOptions): CompanyRun {
  const goal = (opts.goal ?? '').trim();
  if (!goal) throw new OrchestrationError(400, 'goal required');
  const mode: OrchestrationMode = opts.mode === 'parallel' ? 'parallel' : 'pipeline';

  const org = loadOrg(opts.orgIdOrSlug);
  const rawTeams = loadTeams(org.id);
  if (rawTeams.length === 0) throw new OrchestrationError(400, `organization has no active teams: ${org.slug}`);

  validateCompanyPolicy(org, mode, rawTeams);

  const ordered = orderTeams(rawTeams);
  const known = new Set(agentManager.listEnabledIds());
  const avail = liveAvailability(known);
  const now = new Date().toISOString();

  const decomposerCandidates = resolveCompanyDecomposers(org.slug, org.manager, known, avail);
  const executorFallback = allowQueueProviderFailover(org.slug) ? 'ollama' : '';
  const run: CompanyRun = {
    id: createId('corun'),
    orgId: org.id,
    orgName: org.name,
    orgSlug: org.slug,
    goal,
    mode,
    status: 'pending',
    dryRun: opts.dryRun === true,
    projectDir: opts.projectDir,
    maxIterations: Math.min(
      ABSOLUTE_MAX_RUN_ITERATIONS,
      Math.max(1, Math.floor(opts.maxIterations ?? MAX_RUN_ITERATIONS)),
    ),
    completedIterations: 0,
    resumeCount: 0,
    createdAt: now,
    updatedAt: now,
    decomposer: decomposerCandidates[0] ?? null,
    decomposeSource: null,
    workflowRunId: null,
    stages: ordered.map((t) => {
      const executor = resolveExecutor(t, known, executorFallback, avail);
      // 배정 경고 가시화: lead 가 미등록이거나 실행자와 다르면 이유를 stage 에 기록.
      let executorNote: string | undefined;
      if (t.lead && !known.has(t.lead)) {
        executorNote = `lead '${t.lead}' 미등록 프로바이더 → '${executor}' 대체 실행 (역량 불일치 위험)`;
      } else if (t.lead && !avail(t.lead) && t.lead !== executor) {
        executorNote = `lead '${t.lead}' 서킷 open/불가용 → '${executor}' 대체 실행`;
      }
      return {
        teamId: t.id,
        teamSlug: t.slug,
        teamName: t.name,
        rank: rankTeam(t),
        executor,
        subtask: null,
        taskId: null,
        status: 'pending' as StageStatus,
        ...(executorNote ? { executorNote } : {}),
      };
    }),
  };
  const workflowDecision = evaluateWorkflowPolicy(goal, {
    companyRunId: run.id,
    workflowRequired: true,
  });
  run.workflowRunId = createWorkflowRun({
    prompt: goal,
    teamIds: ordered.map(team => team.id),
    companyRunId: run.id,
    source: 'company-orchestrator',
    metadata: {
      organizationId: run.orgId,
      organizationSlug: run.orgSlug,
      mode: run.mode,
    },
    decision: workflowDecision,
  });
  putRun(run, true);

  // 실행은 비동기로 구동(HTTP 응답을 막지 않음). 파이프라인은 수분 걸릴 수 있음.
  launchRunDriver(app, run, ordered, decomposerCandidates, false);

  return run;
}

function launchRunDriver(
  app: FastifyInstance,
  run: CompanyRun,
  teams: TeamRow[],
  decomposers: string[],
  resume: boolean,
): void {
  if (ACTIVE_RUN_DRIVERS.has(run.id)) return;
  ACTIVE_RUN_DRIVERS.add(run.id);
  void (async () => {
    if (resume) {
      await reconcilePersistedStages(app, run);
      const incomplete = run.stages.some((stage) => stage.status !== 'completed');
      run.resumeCount += 1;
      touch(run);
      const decision = decideCompanyRunResume({
        incomplete,
        resumeCount: run.resumeCount,
        completedIterations: run.completedIterations,
        maxIterations: run.maxIterations,
        maxResumes: MAX_RUN_RESUMES,
      });
      if (decision === 'recovery_budget_exhausted') {
        finalizeRun(run);
        run.error = `restart recovery budget exhausted (${MAX_RUN_RESUMES})`;
        touch(run);
        return;
      }
      if (decision === 'iteration_budget_exhausted') {
        finalizeRun(run);
        return;
      }
    }
    await driveRun(app, run.id, teams, run.projectDir, decomposers, resume);
  })().catch((err) => {
    const current = RUNS.get(run.id);
    if (current) {
      current.status = 'failed';
      current.error = err instanceof Error ? err.message : String(err);
      current.updatedAt = new Date().toISOString();
      // 저장소 장애가 원인이라면 다시 throw하지 않고 마지막 best-effort 기록만
      // 시도한다. 실행 드라이버는 이미 중단되어 추가 외부 작업은 진행하지 않는다.
      persistRun(current);
    }
    log.error({
      err: err instanceof Error ? err.message : String(err),
      runId: run.id,
      resume,
    }, 'company run drive failed');
  }).finally(() => {
    ACTIVE_RUN_DRIVERS.delete(run.id);
  });
}

async function reconcilePersistedStages(app: FastifyInstance, run: CompanyRun): Promise<void> {
  for (let index = 0; index < run.stages.length; index++) {
    const stage = run.stages[index];
    if (!stage.taskId || !['running', 'pending'].includes(stage.status)) continue;
    const result = await waitForTask(stage.taskId, PIPELINE_STAGE_TIMEOUT_MS, run);
    if (result.status === 'timed_out') {
      await abortTimedOutCompanyTask(app, run.id, stage.taskId);
    }
    stage.outputSnippet = (result.response ?? '').slice(0, PIPELINE_HANDOFF_CHARS);
    stage.outputChars = (result.response ?? '').length;
    const acceptable = result.status === 'completed' && isCompanyStageOutputAcceptable(result.response, {
      isLastStage: index === run.stages.length - 1,
      requireProtocolPrefix: result.requireProtocolPrefix,
    });
    stage.status = acceptable ? 'completed' : (result.status as StageStatus);
    if (!acceptable) {
      stage.error = result.status === 'completed'
        ? `insufficient output (${stage.outputChars}자)`
        : `recovered task ${result.status}`;
    }
    touch(run);
  }
}

/**
 * 부팅 시 DB에 남은 비종결 회사 실행을 복원한다.
 * 동일 프로세스에서 이미 구동 중인 run은 ACTIVE_RUN_DRIVERS로 중복 실행을 막는다.
 */
export function resumeCompanyRuns(app: FastifyInstance): number {
  let rows: Array<{ run_json: string }> = [];
  try {
    rows = getDb().prepare(`
      SELECT run_json
      FROM company_runs
      WHERE status IN ('pending','decomposing','dispatching','running','dispatched')
      ORDER BY created_at ASC
    `).all() as Array<{ run_json: string }>;
  } catch (error) {
    throw new Error(
      `company run resume store unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let resumed = 0;
  for (const row of rows) {
    const run = parsePersistedRun(row.run_json);
    if (!run || ACTIVE_RUN_DRIVERS.has(run.id)) continue;
    try {
      const org = loadOrg(run.orgId);
      const teams = orderTeams(loadTeams(org.id));
      validateCompanyPolicy(org, run.mode, teams);
      const known = new Set(agentManager.listEnabledIds());
      const decomposers = resolveCompanyDecomposers(
        run.orgSlug,
        org.manager,
        known,
        liveAvailability(known),
      );
      putRun(run, true);
      launchRunDriver(app, run, teams, decomposers, true);
      resumed++;
    } catch (error) {
      if (error instanceof OrchestrationError && error.code === 503) {
        throw error;
      }
      run.status = 'failed';
      run.error = `resume failed: ${error instanceof Error ? error.message : String(error)}`;
      putRun(run, true);
    }
  }
  return resumed;
}

async function driveRun(
  app: FastifyInstance,
  runId: string,
  teams: TeamRow[],
  projectDir: string,
  decomposers: string[],
  resume = false,
): Promise<void> {
  const run = RUNS.get(runId);
  if (!run) return;
  if (run.orgSlug === 'computer-use' && !run.dryRun) {
    run.computerUse = {
      provider: 'codex',
      status: 'activating',
      message: 'Codex 전용 Computer Use 제어권을 활성화하는 중입니다',
    };
    touch(run);
    let lease;
    try {
      lease = await acquireComputerUseLease(run.id, {
        onWaiting: (ownerRunId) => {
          run.computerUse = {
            provider: 'codex',
            status: 'waiting',
            message: `다른 실행(${ownerRunId ?? 'unknown'})이 제어 중이므로 대기합니다`,
            ...(ownerRunId ? { queuedBehindRunId: ownerRunId } : {}),
          };
          touch(run);
        },
        onHeartbeatError: (error) => {
          if (run.computerUse?.status === 'active') {
            run.computerUse.status = 'failed';
            run.computerUse.message = `제어권 연결 확인 실패: ${error.message}`;
            touch(run);
          }
        },
      });
      run.computerUse = {
        provider: 'codex',
        status: 'active',
        message: 'Codex 한 세션에만 Computer Use 제어권이 부여되었습니다',
        activatedAt: new Date().toISOString(),
      };
      touch(run);
    } catch (error) {
      run.computerUse = {
        provider: 'codex',
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      };
      touch(run);
      throw error;
    }

    let driveError: unknown;
    try {
      await driveRunBody(app, runId, teams, projectDir, decomposers, resume);
    } catch (error) {
      driveError = error;
    } finally {
      run.computerUse = {
        provider: 'codex',
        status: 'releasing',
        message: '작업 종료에 따라 Computer Use 제어권을 회수하는 중입니다',
        activatedAt: run.computerUse?.activatedAt,
      };
      touch(run);
      try {
        await lease.release();
        run.computerUse = {
          provider: 'codex',
          status: 'released',
          message: 'Computer Use MCP가 비활성화되고 제어권이 회수되었습니다',
          activatedAt: run.computerUse?.activatedAt,
          releasedAt: new Date().toISOString(),
        };
        touch(run);
      } catch (releaseError) {
        run.computerUse = {
          provider: 'codex',
          status: 'failed',
          message: `제어권 회수 실패: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
          activatedAt: run.computerUse?.activatedAt,
        };
        touch(run);
        throw releaseError;
      }
    }
    if (driveError) throw driveError;
    return;
  }
  await driveRunBody(app, runId, teams, projectDir, decomposers, resume);
}

function ensureCompanyWorkflowRun(run: CompanyRun, teams: TeamRow[]): string {
  if (run.workflowRunId) return run.workflowRunId;
  const decision = evaluateWorkflowPolicy(run.goal, {
    companyRunId: run.id,
    workflowRequired: true,
  });
  run.workflowRunId = createWorkflowRun({
    prompt: run.goal,
    teamIds: teams.map(team => team.id),
    companyRunId: run.id,
    source: 'company-orchestrator-resume',
    metadata: {
      organizationId: run.orgId,
      organizationSlug: run.orgSlug,
      resumed: true,
    },
    decision,
  });
  touch(run);
  return run.workflowRunId;
}

function selectWorkflowProviders(decomposers: string[]): string[] {
  const known = new Set(agentManager.listEnabledIds());
  const available = liveAvailability(known);
  return [...new Set([...decomposers, ...DECOMPOSER_PREFS, ...known])]
    .filter(provider => known.has(provider) && available(provider))
    .slice(0, 3);
}

async function ensureCompanyPlanningDiscussion(
  run: CompanyRun,
  teams: TeamRow[],
  decomposers: string[],
): Promise<string> {
  const workflowRunId = ensureCompanyWorkflowRun(run, teams);
  const remaining = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_stages
    WHERE workflow_run_id=? AND stage='discussion' AND required=1 AND status<>'completed'
  `).get(workflowRunId) as { count: number };
  if (remaining.count === 0) {
    const existing = getDb().prepare(`
      SELECT report
      FROM discussions
      WHERE workflow_run_id=? AND status='completed'
      ORDER BY ended_at DESC LIMIT 1
    `).get(workflowRunId) as { report: string | null } | undefined;
    return existing?.report ?? '';
  }

  const providers = selectWorkflowProviders(decomposers);
  if (providers.length === 0) {
    markWorkflowStage(workflowRunId, 'discussion', 'failed', {
      error: 'no_available_discussion_provider',
    });
    throw new Error('required workflow discussion has no available provider');
  }
  markWorkflowStage(workflowRunId, 'discussion', 'running', {
    executor: providers.join(','),
  });
  try {
    const report = await discussionEngine.startDiscussion({
      topic: [
        `[회사 워크플로우 필수 토론] ${run.orgName}`,
        `[목표] ${run.goal}`,
        `[팀 역할] ${teams.map(team => `${team.name}: ${team.charter ?? team.description ?? team.slug}`).join(' | ')}`,
        '독립 제안, 상호 평가, 반대 의견과 위험, 검증 가능한 성공 기준을 포함한 실행 설계를 합의하라.',
      ].join('\n'),
      mode: 'discussion',
      providers,
      maxRounds: 3,
      initiator: 'company-orchestrator',
      companyRunId: run.id,
      workflowRunId,
    });
    return report.adoptedProposal;
  } catch (error) {
    markWorkflowStage(workflowRunId, 'discussion', 'failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function completeCompanyWorkflowQuality(
  run: CompanyRun,
  teams: TeamRow[],
  projectDir: string,
  decomposers: string[],
): Promise<boolean> {
  const workflowRunId = ensureCompanyWorkflowRun(run, teams);
  const providers = selectWorkflowProviders(decomposers);
  const provider = providers[0];
  if (!provider) return false;
  const outputs = run.stages
    .filter(stage => stage.outputSnippet)
    .map(stage => `[${stage.teamName}]\n${stage.outputSnippet}`)
    .join('\n\n')
    .slice(0, 20_000);

  for (const stage of ['review', 'verification'] as const) {
    const pending = getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM workflow_stages
      WHERE workflow_run_id=? AND stage=? AND required=1 AND status<>'completed'
    `).get(workflowRunId, stage) as { count: number };
    if (pending.count === 0) continue;
    markWorkflowStage(workflowRunId, stage, 'running', { executor: provider });
    const prompt = stage === 'review'
      ? [
        `[필수 교차 리뷰] 회사 목표: ${run.goal}`,
        '아래 팀 산출물의 누락, 충돌, 근거 부족, 회귀 위험을 검토하라. 파일 수정은 하지 말고 승인/반려 근거와 Gap을 제시하라.',
        outputs,
      ].join('\n\n')
      : [
        `[필수 검증] 회사 목표: ${run.goal}`,
        '아래 산출물의 핵심 주장을 가능한 명령·DB·HTTP·파일 근거로 검증하고 성공/실패/미검증을 구분하라.',
        outputs,
      ].join('\n\n');
    try {
      const result = await withHardTimeout(
        agentManager.executeTask(provider, prompt, {
          projectDir,
          timeoutMs: DECOMPOSE_TIMEOUT_MS,
        }),
        DECOMPOSE_TIMEOUT_MS + 5000,
      );
      if (!result.success || !result.output?.trim()) {
        const error = result.error || `${stage}_empty_output`;
        markWorkflowStage(workflowRunId, stage, 'failed', { executor: provider, error });
        return false;
      }
      markWorkflowStage(workflowRunId, stage, 'completed', {
        executor: provider,
        evidence: {
          provider,
          output: result.output.slice(0, 20_000),
        },
      });
    } catch (error) {
      markWorkflowStage(workflowRunId, stage, 'failed', {
        executor: provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
  return true;
}

async function driveRunBody(
  app: FastifyInstance,
  runId: string,
  teams: TeamRow[],
  projectDir: string,
  decomposers: string[],
  resume = false,
): Promise<void> {
  const run = RUNS.get(runId);
  if (!run) return;
  const teamBySlug = new Map(teams.map((t) => [t.slug, t]));
  const workflowRunId = ensureCompanyWorkflowRun(run, teams);
  const planningContext = await ensureCompanyPlanningDiscussion(run, teams, decomposers);

  // 1) 분해(LLM 매니저) — 후보 프로바이더를 순서대로 시도, 첫 파싱성공 채택.
  //    각 시도 직전 서킷 재확인(그 사이 리밋 걸린 provider 즉시 스킵) + 하드 타임아웃 race
  //    (executeTask 내부 abort 가 늦어도 후보 넘어가도록).
  if (!resume || run.stages.some((stage) => !stage.subtask)) {
    run.status = 'decomposing'; touch(run);
    markWorkflowStage(workflowRunId, 'design', 'running', {
      executor: run.decomposer,
    });
    let decomposition: Record<string, string> | null = null;
    const prompt = [
      buildDecompositionPrompt(run.orgName, run.goal, teams),
      planningContext
        ? `\n[필수 토론 합의안]\n${planningContext.slice(0, 12_000)}`
        : '',
    ].join('');
    const known = new Set(agentManager.listEnabledIds());
    const avail = liveAvailability(known);
    let attempts = 0;
    for (const cand of decomposers) {
      if (!avail(cand)) { log.warn({ runId, cand }, 'decomposer circuit open/unavailable, skipping'); continue; }
      if (attempts >= MAX_DECOMPOSE_ATTEMPTS) { log.warn({ runId, attempts }, 'decompose attempt cap reached, falling back to template'); break; }
      attempts++;
      try {
        run.decomposer = cand; touch(run);
        const res = await withHardTimeout(
          agentManager.executeTask(cand, prompt, { projectDir, timeoutMs: DECOMPOSE_TIMEOUT_MS }),
          DECOMPOSE_TIMEOUT_MS + 5000,
        );
        if (res && res.success && res.output) {
          const parsed = parseDecomposition(res.output, teams);
          if (parsed) { decomposition = parsed; run.decomposer = cand; break; }
        }
        log.warn({ runId, cand, success: res?.success }, 'decomposer produced no parseable JSON, trying next');
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), runId, cand }, 'decomposer threw/timed out, trying next');
      }
    }
    run.decomposeSource = decomposition ? 'llm' : 'template';

    // 2) 각 단계 하위작업 확정(분해 결과 우선, 없으면 템플릿)
    for (const stage of run.stages) {
      const team = teamBySlug.get(stage.teamSlug)!;
      stage.subtask = scopeDecomposedSubtask(team, run.goal, decomposition?.[stage.teamSlug]);
    }
    markWorkflowStage(workflowRunId, 'design', 'completed', {
      executor: run.decomposer,
      evidence: {
        source: run.decomposeSource,
        decomposer: run.decomposer,
        decomposition: Object.fromEntries(run.stages.map(stage => [stage.teamSlug, stage.subtask])),
      },
    });
    touch(run);
  } else {
    // Persisted runs from before the workflow migration already carry a valid
    // decomposition.  Record that recovered design instead of re-running it.
    markWorkflowStage(workflowRunId, 'design', 'completed', {
      executor: run.decomposer,
      evidence: {
        source: run.decomposeSource ?? 'persisted',
        recovered: true,
      },
    });
  }

  // 2.5) 역량 기반 실행자 재선정 — subtask 확정 후 dispatch 전, 깨진/제거 lead 를 무시하고
  //      subtask 유형(inferTaskType)으로 현재 가용 프로바이더 중 최적 실행자 재배정.
  //      lead 가 유효·가용하면 팀 설계 존중해 유지. 분해 대기 이후 fresh availability 사용.
  const knownNow = new Set(agentManager.listEnabledIds());
  const availNow = liveAvailability(knownNow);
  for (const stage of run.stages) {
    const team = teamBySlug.get(stage.teamSlug)!;
    const before = stage.executor;
    const sel = selectCompanyStageExecutor(run.orgSlug, team, stage.subtask ?? '', knownNow, availNow);
    stage.executor = sel.executor;
    if (sel.note) stage.executorNote = sel.note;
    if (sel.executor !== before) {
      log.info({ runId, team: stage.teamSlug, before, after: sel.executor, taskType: sel.taskType },
        'capability re-selection');
    }
  }
  touch(run);

  if (run.dryRun) { run.status = 'planned'; touch(run); return; }

  // ── 루프 앤진(닫힌 자기교정 루프): EXECUTE → VERIFY → (fail) REFINE → EXECUTE, 완벽 완료까지 반복 ──
  // 미완료 단계를 매 반복 fresh 가용성으로 실행자 재선정(REFINE) 후 재실행. 전 단계 completed 또는 MAX 반복까지.
  const baseSubtasks = new Map(run.stages.map((s) => [s.teamSlug, s.subtask ?? '']));
  const firstIteration = Math.min(run.maxIterations, Math.max(1, run.completedIterations + 1));
  for (let iteration = firstIteration; iteration <= run.maxIterations; iteration++) {
    if (isCompanyRunCancelled(run)) return;
    run.iteration = iteration;
    touch(run);
    // REFINE: 2회차부터 미완료 단계 실행자 재선정(서킷/리밋 회복 반영) + 상태 초기화
    if (iteration > 1) {
      if (isCompanyRunCancelled(run)) return;
      const k = new Set(agentManager.listEnabledIds());
      const a = liveAvailability(k);
      for (const stage of run.stages) {
        if (stage.status === 'completed') continue;
        const team = teamBySlug.get(stage.teamSlug)!;
        const sel = selectCompanyStageExecutor(
          run.orgSlug,
          team,
          baseSubtasks.get(stage.teamSlug) ?? '',
          k,
          a,
        );
        stage.executor = sel.executor;
        if (sel.note) stage.executorNote = sel.note;
        stage.status = 'pending'; stage.taskId = null; stage.error = undefined; stage.attempt = undefined;
      }
      touch(run);
    }

    // EXECUTE (미완료 단계만)
    if (run.mode === 'parallel') {
      await executeParallelOnce(app, run, teamBySlug, projectDir, baseSubtasks);
    } else {
      await executePipelineOnce(app, run, teamBySlug, projectDir, baseSubtasks);
    }
    if (isCompanyRunCancelled(run)) return;

    // VERIFY: 전 단계 완료면 성공 확정하고 루프 종료
    run.completedIterations = iteration;
    touch(run);
    const safelyRejected = run.orgSlug === 'technology-porting' && run.portDecision === 'reject';
    if (run.stages.every((s) => s.status === 'completed' || (safelyRejected && s.status === 'skipped'))) {
      const qualityComplete = await completeCompanyWorkflowQuality(
        run,
        teams,
        projectDir,
        decomposers,
      );
      if (!qualityComplete) {
        log.warn({ runId, iteration }, 'workflow review/verification incomplete');
        if (iteration < run.maxIterations) continue;
        finalizeRun(run);
        return;
      }
      run.status = 'completed';
      run.summary = summarizeRun(run);
      touch(run);
      return;
    }

    // 미완료 → 다음 반복(서킷 회복 대기). 마지막 반복이면 루프 탈출.
    if (iteration < run.maxIterations) {
      if (isCompanyRunCancelled(run)) return;
      run.status = 'running'; touch(run);
      log.warn({ runId, iteration,
        incomplete: run.stages.filter((s) => s.status !== 'completed').map((s) => s.teamSlug) },
        'loop-engine: iteration incomplete — refining executors and retrying');
      await sleep(LOOP_BACKOFF_MS);
    }
  }

  // MAX 반복 후에도 미완료 → partial/failed 확정 (취소는 보존)
  if (isCompanyRunCancelled(run)) return;
  run.iteration = run.maxIterations;
  finalizeRun(run);
}

// 파이프라인 1회 실행(미완료 단계만). completed 단계는 산출물만 handoff 소스로 사용하고 건너뜀.
// 한 단계가 failover 소진으로 실패하면 즉시 반환(루프 앤진이 다음 반복에서 재시도).
async function executePipelineOnce(
  app: FastifyInstance, run: CompanyRun,
  teamBySlug: Map<string, TeamRow>, projectDir: string, baseSubtasks: Map<string, string>,
): Promise<void> {
  if (isCompanyRunCancelled(run)) return;
  run.status = 'running'; touch(run);
  let prev: RunStage | null = null;
  for (let s = 0; s < run.stages.length; s++) {
    if (isCompanyRunCancelled(run)) return;
    const stage = run.stages[s];
    if (stage.status === 'completed') { prev = stage; continue; } // 이미 완료 — handoff 소스로만
    const team = teamBySlug.get(stage.teamSlug)!;
    let subtask = baseSubtasks.get(stage.teamSlug) ?? '';
    if (prev?.outputSnippet) {
      subtask = buildPipelineHandoffSubtask(
        stage.teamSlug,
        subtask,
        prev.teamName,
        prev.outputSnippet,
      );
    }
    stage.subtask = subtask;
    const isLast = s === run.stages.length - 1;
    const ok = await runStageWithFailover(app, run, stage, team, projectDir, isLast);
    if (!ok) return; // 이 단계 failover 소진 → 이번 반복 중단(루프가 재시도)
    if (run.orgSlug === 'technology-porting' && stage.teamSlug === 'tech-port-07-value-gate-report') {
      const decision = parsePortDecision(stage.outputSnippet);
      run.portDecision = decision;
      if (decision === 'undetermined') {
        stage.status = 'failed';
        stage.error = '가치판단 리포트에 단일 PORT_DECISION: APPROVE 또는 REJECT가 없습니다';
        touch(run);
        return;
      }
      if (decision === 'reject') {
        for (const downstream of run.stages.slice(s + 1)) {
          downstream.status = 'skipped';
          downstream.error = 'PORT_DECISION: REJECT — 안전정책에 따라 이식 작업을 실행하지 않음';
        }
        touch(run);
        return;
      }
    }
    prev = stage;
  }
}

// 병렬 1회 실행(미완료 단계만): dispatch → 수집 → 실패건 1회 대체 재시도.
async function executeParallelOnce(
  app: FastifyInstance, run: CompanyRun,
  teamBySlug: Map<string, TeamRow>, projectDir: string, baseSubtasks: Map<string, string>,
): Promise<void> {
  if (isCompanyRunCancelled(run)) return;
  run.status = 'dispatching'; touch(run);
  const pKnown = new Set(agentManager.listEnabledIds());
  const pAvail = liveAvailability(pKnown);
  const allowOutsideTeam = allowQueueProviderFailover(run.orgSlug);
  const executorFallback = allowOutsideTeam ? 'ollama' : '';
  const pending = run.stages.filter((s) => s.status !== 'completed');
  for (const stage of pending) {
    if (isCompanyRunCancelled(run)) return;
    stage.subtask = baseSubtasks.get(stage.teamSlug) ?? stage.subtask;
    const team = teamBySlug.get(stage.teamSlug)!;
    const chain = resolveExecutorChain(team, pKnown, executorFallback, pAvail);
    const seeded = stage.executor
      && pKnown.has(stage.executor)
      && (allowOutsideTeam || isDeclaredTeamExecutor(team, stage.executor))
      ? [stage.executor, ...chain.filter((x) => x !== stage.executor)]
      : chain;
    for (const c of seeded) { if (await providerModelDispatchable(c)) { stage.executor = c; break; } }
    await dispatchStage(app, run, stage, projectDir);
    await sleep(PARALLEL_STAGGER_MS);
  }
  if (isCompanyRunCancelled(run)) return;
  run.status = 'running'; touch(run);
  await Promise.all(pending.map((stage) => collectStage(app, stage, run)));
  if (isCompanyRunCancelled(run)) return;
  await retryFailedStagesParallel(app, run, teamBySlug, projectDir);
}

function summarizeRun(run: CompanyRun): { total: number; succeeded: number; failed: number; retried: number; skipped?: number } {
  const total = run.stages.length;
  const succeeded = run.stages.filter((s) => s.status === 'completed').length;
  const skipped = run.stages.filter((s) => s.status === 'skipped').length;
  const retried = run.stages.filter((s) => (s.retryCount ?? 0) > 0 || (s.attempt ?? 1) > 1).length;
  return { total, succeeded, failed: total - succeeded - skipped, retried, ...(skipped ? { skipped } : {}) };
}

// 루프 소진 후 최종 상태 확정(completed/partial/failed). 취소는 덮어쓰지 않음.
function finalizeRun(run: CompanyRun): void {
  if (isCompanyRunCancelled(run)) {
    run.summary = summarizeRun(run);
    touch(run);
    return;
  }
  run.summary = summarizeRun(run);
  const failed = run.summary.failed;
  run.status = failed === 0 ? 'completed' : run.summary.succeeded > 0 ? 'partial' : 'failed';
  if (failed > 0) {
    run.error = `루프 ${run.iteration ?? run.maxIterations}회 후 ${failed}/${run.summary.total} 미완료: ` +
      run.stages.filter((s) => s.status !== 'completed')
                .map((s) => `${s.teamSlug}(${s.executor})`).join(', ');
  }
  touch(run);
}

// 단계를 후보 실행자 체인으로 failover 실행. completed && (최종stage거나 실질산출)이면 true.
async function runStageWithFailover(
  app: FastifyInstance, run: CompanyRun, stage: RunStage,
  team: TeamRow, projectDir: string, isLastStage: boolean,
): Promise<boolean> {
  const known = new Set(agentManager.listEnabledIds());
  const avail = liveAvailability(known);
  const allowOutsideTeam = allowQueueProviderFailover(run.orgSlug);
  const executorFallback = allowOutsideTeam ? 'ollama' : '';
  const roleChain = resolveExecutorChain(team, known, executorFallback, avail);
  // cap-3 역량 재선정으로 세팅된 stage.executor 를 attempt#1 로 seed(등록된 경우).
  const seeded = stage.executor
    && known.has(stage.executor)
    && (allowOutsideTeam || isDeclaredTeamExecutor(team, stage.executor))
    ? [stage.executor, ...roleChain.filter((x) => x !== stage.executor)]
    : roleChain;
  // R3 모델검증 통과 후보만, 최대 MAX_STAGE_ATTEMPTS
  const chain: string[] = [];
  for (const id of seeded) {
    if (await providerModelDispatchable(id)) chain.push(id);
    if (chain.length >= MAX_STAGE_ATTEMPTS) break;
  }
  if (chain.length === 0 && !allowOutsideTeam) {
    stage.status = 'failed';
    stage.error = '헌정/안전 회사의 선언된 팀원 중 실행 가능한 프로바이더가 없습니다';
    touch(run);
    return false;
  }
  const candidates = chain.length ? chain : [stage.executor];
  const baseSubtask = stage.subtask ?? '';
  let lastError = '';
  for (let i = 0; i < candidates.length; i++) {
    if (isCompanyRunCancelled(run)) return false;
    const exec = candidates[i];
    if (i > 0 && !avail(exec)) { lastError = `${exec} unavailable`; continue; }
    stage.executor = exec;
    stage.subtask = baseSubtask;
    stage.attempt = i + 1;
    stage.taskId = null;
    const ok = await dispatchStage(app, run, stage, projectDir);
    if (!ok || !stage.taskId) {
      if (isCompanyRunCancelled(run)) return false;
      lastError = stage.error ?? `${exec} dispatch failed`;
      continue;
    }
    stage.status = 'running'; touch(run);
    const result = await waitForTask(stage.taskId, PIPELINE_STAGE_TIMEOUT_MS, run);
    if (result.status === 'timed_out') {
      await abortTimedOutCompanyTask(app, run.id, stage.taskId);
    }
    if (result.status === 'cancelled' || isCompanyRunCancelled(run)) {
      stage.status = 'cancelled';
      stage.error = stage.error ?? 'run cancelled';
      touch(run);
      return false;
    }
    stage.status = (result.status as StageStatus) ?? 'failed';
    stage.outputSnippet = (result.response ?? '').slice(0, PIPELINE_HANDOFF_CHARS);
    stage.outputChars = (result.response ?? '').length;
    touch(run);
    // 최종 stage는 길이 게이트만 예외다. 품질 게이트까지 우회하면 도구 호출 에코가
    // 완료로 오인되어 같은 회사 실행을 다시 트리거하므로 모든 단계에 품질 검사를 적용한다.
    const acceptable = isCompanyStageOutputAcceptable(result.response, {
      isLastStage,
      requireProtocolPrefix: result.requireProtocolPrefix,
    });
    if (result.status === 'completed' && acceptable) {
      stage.error = undefined;
      return true;
    }
    lastError = result.status !== 'completed'
      ? `${exec} ${result.status}`
      : `${exec} insufficient output (${stage.outputChars}자)`;
    stage.error = lastError;
    log.warn({ runId: run.id, stage: stage.teamSlug, exec, attempt: i + 1, lastError },
      'stage attempt failed, trying next executor');
  }
  if (isCompanyRunCancelled(run)) return false;
  stage.status = 'failed';
  stage.error = `all executors failed: ${lastError}`;
  return false;
}

export function classifyCompanyWorkflowStage(stage: Pick<RunStage, 'teamSlug' | 'teamName'>): WorkflowStage {
  const text = `${stage.teamSlug} ${stage.teamName}`;
  if (/discussion|debate|consensus|collaboration|토론|논의|합의/i.test(text)) return 'discussion';
  if (/verification|verify|test|reliability|resilience|검증|테스트|신뢰성/i.test(text)) return 'verification';
  if (/review|audit|quality|safety|redteam|gate|리뷰|감사|품질|안전|검수/i.test(text)) return 'review';
  if (/strategy|architect|design|plan|intake|전략|설계|기획|접수/i.test(text)) return 'design';
  return 'implementation';
}

// 단일 팀 태스크 dispatch(inject POST /api/task + team_id 태그). 성공 시 true.
async function dispatchStage(app: FastifyInstance, run: CompanyRun, stage: RunStage, projectDir: string): Promise<boolean> {
  if (isCompanyRunCancelled(run)) return false;
  try {
    const workflowStage = classifyCompanyWorkflowStage(stage);
    const res = await app.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        ai: stage.executor,
        prompt: stage.subtask ?? '',
        mode: 'task',
        callerAgentId: 'company-orchestrator',
        metadata: {
          projectDir,
          allowProviderFailover: allowQueueProviderFailover(run.orgSlug),
          organizationId: run.orgId,
          teamId: stage.teamId,
          companyRunId: run.id,
          workflowRunId: run.workflowRunId,
          workflowStage,
          workflowRequired: true,
          qualityRetryOwner: 'company-orchestrator',
        },
      },
    });
    const body = res.json() as { taskId?: string; agentId?: string; error?: string };
    if (res.statusCode !== 202 || !body.taskId) {
      stage.status = 'failed';
      stage.error = body?.error ? `${res.statusCode}: ${body.error}` : `HTTP ${res.statusCode}`;
      touch(run);
      return false;
    }
    stage.taskId = body.taskId;
    if (body.agentId) stage.executor = body.agentId; // failover 후 실제 실행자
    // team_id 컬럼 명시 태그(라우트가 자동설정 안 함)
    getDb().prepare(`UPDATE tasks SET team_id=?, updated_at=datetime('now') WHERE id=?`).run(stage.teamId, body.taskId);
    touch(run);
    return true;
  } catch (err) {
    stage.status = 'failed';
    stage.error = err instanceof Error ? err.message : String(err);
    touch(run);
    return false;
  }
}

// ── 모델 존재 사전검증(ProviderModelNotFoundError 선차단) ──
const MODEL_CACHE_TTL_MS = 60 * 1000;
const modelListCache = new Map<string, { at: number; models: Set<string> }>();

export async function providerModelDispatchable(id: string): Promise<boolean> {
  const provider = agentManager.getProvider(id);
  if (!provider) return false; // 제거된 lead(retired-provider 등) → 즉시 배제
  if (provider.type !== 'api') return true; // CLI/local 은 런타임 모델 해석 → 통과
  const wanted = provider.model || provider.apiConfig?.primary.model;
  if (!wanted) return true; // 서버 기본 모델 → 통과
  const baseUrl = provider.endpoint || provider.apiConfig?.primary.baseUrl;
  if (!baseUrl) return true; // 검증 불가 → 보수적 통과
  try {
    const cached = modelListCache.get(id);
    let models: Set<string>;
    if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) {
      models = cached.models;
    } else {
      const root = baseUrl.replace(/\/(v1\/?)?$/, '');
      const resp = await fetch(`${root}/v1/models`, { signal: AbortSignal.timeout(4000) });
      if (!resp.ok) return true; // 목록 조회 실패 → 보수적 통과
      const data = await resp.json() as { data?: Array<{ id?: string }> };
      models = new Set((data.data ?? []).map((m) => (m.id ?? '').toLowerCase()));
      modelListCache.set(id, { at: Date.now(), models });
    }
    if (models.size === 0) return true;
    const w = wanted.toLowerCase();
    return [...models].some((m) => m === w || m.startsWith(w.split(':')[0]));
  } catch {
    return true; // 네트워크 오류 → 보수적 통과
  }
}

const TERMINAL = new Set(['completed', 'failed', 'timed_out', 'cancelled']);
const DECOMPOSE_TIMEOUT_MS = 60 * 1000;  // 분해 후보당 상한(짧게 — 팀 dispatch 지연 방지)
const MAX_DECOMPOSE_ATTEMPTS = 3;        // 최대 3후보만 실제 시도 후 템플릿 폴백(전체 상한 ~3분)
const PIPELINE_STAGE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STAGE_ATTEMPTS = 3;            // 순차 단계 failover: 초기 1 + 대체 2회
const PARALLEL_STAGE_TIMEOUT_MS = 10 * 60 * 1000; // 병렬 단계당 완료 대기 상한
const PARALLEL_STAGGER_MS = 400;         // dispatch 스태거(로컬 단일스레드 보호)
const MAX_RUN_ITERATIONS = 5;            // 루프 앤진: 완료-루프 최대 반복(닫힌 자기교정)
const ABSOLUTE_MAX_RUN_ITERATIONS = 10;   // 외부 입력으로 무한 루프를 만들 수 없게 하는 절대 상한
const MAX_RUN_RESUMES = 3;                // 반복 예산과 별도인 프로세스 재시작 복구 절대 상한
const LOOP_BACKOFF_MS = 15 * 1000;       // 반복 사이 대기(서킷/리밋 회복 여유)
const PIPELINE_HANDOFF_CHARS = 4000;
const POLL_MS = 2000;

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// 프로미스에 하드 상한. 초과 시 reject(내부 abort 가 늦어도 호출부가 다음 후보로 넘어가게).
function withHardTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`hard timeout ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); },
           (e) => { clearTimeout(timer); reject(e); });
  });
}

// tasks.status 폴링으로 태스크 완료 대기. 터미널 상태 또는 timeout 시 반환.
async function waitForTask(taskId: string, timeoutMs: number, run?: CompanyRun): Promise<{
  status: string;
  response: string | null;
  requireProtocolPrefix: boolean;
}> {
  const db = getDb();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (run && isCompanyRunCancelled(run)) {
      return { status: 'cancelled', response: null, requireProtocolPrefix: false };
    }
    const row = db.prepare(`SELECT status, response, prompt FROM tasks WHERE id=?`).get(taskId) as
      { status: string | null; response: string | null; prompt: string | null } | undefined;
    const status = row?.status ?? 'failed';
    if (!row) return { status: 'failed', response: null, requireProtocolPrefix: false };
    if (TERMINAL.has(status)) {
      return {
        status,
        response: row.response ?? null,
        requireProtocolPrefix: hasResponseContract(row.prompt),
      };
    }
    if (Date.now() >= deadline) {
      return {
        status: 'timed_out',
        response: row.response ?? null,
        requireProtocolPrefix: hasResponseContract(row.prompt),
      };
    }
    await sleep(POLL_MS);
  }
}

/**
 * A timed-out task may still be executing and editing its worktree. Abort it
 * before any failover overwrites stage.taskId or dispatches another executor.
 * Fail closed: if cancellation cannot be confirmed, throw and stop the driver.
 */
export async function abortTimedOutCompanyTask(
  app: FastifyInstance,
  runId: string,
  taskId: string,
): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/tasks/${encodeURIComponent(taskId)}/cancel`,
    payload: {},
  });
  let body: { ok?: boolean; status?: string; error?: string } = {};
  try {
    body = response.json() as typeof body;
  } catch {
    // The status code below still produces an actionable failure.
  }
  if (response.statusCode >= 200 && response.statusCode < 300 && body.ok === true) {
    log.warn({ runId, taskId, taskStatus: body.status }, 'Timed-out company task aborted before failover');
    return;
  }
  throw new Error(
    `timed-out company task abort failed: run=${runId} task=${taskId} ` +
    `HTTP ${response.statusCode}${body.error ? ` ${body.error}` : ''}`,
  );
}

// 단일 단계 결과 수집: 완료 대기 → 산출물/상태 기록 → 빈 산출물 게이트.
async function collectStage(app: FastifyInstance, stage: RunStage, run: CompanyRun): Promise<void> {
  if (!stage.taskId) return; // dispatch 실패 — status 이미 'failed'
  stage.status = 'running'; touch(run);
  const result = await waitForTask(stage.taskId, PARALLEL_STAGE_TIMEOUT_MS, run);
  if (result.status === 'timed_out') {
    await abortTimedOutCompanyTask(app, run.id, stage.taskId);
  }
  stage.outputSnippet = (result.response ?? '').slice(0, PIPELINE_HANDOFF_CHARS);
  stage.outputChars = (result.response ?? '').length;
  if (result.status === 'completed' && isCompanyStageOutputAcceptable(result.response, {
    isLastStage: false,
    requireProtocolPrefix: result.requireProtocolPrefix,
  })) {
    stage.status = 'completed';
  } else if (result.status === 'completed') {
    stage.status = 'failed';
    stage.error = `insufficient output (${stage.outputChars}자)`;
  } else {
    stage.status = (result.status as StageStatus) ?? 'failed';
    stage.error = stage.error ?? `task ${result.status}`;
  }
  touch(run);
}

// 실패 단계만 대체 실행자(체인 다음 후보)로 1회 재시도(병렬).
async function retryFailedStagesParallel(
  app: FastifyInstance, run: CompanyRun,
  teamBySlug: Map<string, TeamRow>, projectDir: string,
): Promise<void> {
  if (isCompanyRunCancelled(run)) return;
  const failed = run.stages.filter((s) =>
    s.status !== 'completed' && s.status !== 'cancelled' && (s.retryCount ?? 0) < 1);
  if (failed.length === 0) return;
  const known = new Set(agentManager.listEnabledIds());
  const avail = liveAvailability(known);
  const executorFallback = allowQueueProviderFailover(run.orgSlug) ? 'ollama' : '';
  await Promise.all(failed.map(async (stage) => {
    if (isCompanyRunCancelled(run)) return;
    const team = teamBySlug.get(stage.teamSlug);
    if (!team) return;
    const chain = resolveExecutorChain(team, known, executorFallback, avail);
    let alt: string | null = null;
    for (const c of chain) {
      if (c === stage.executor) continue;
      if (await providerModelDispatchable(c)) { alt = c; break; }
    }
    if (!alt) return; // 유효한 대체자 없음 → 재시도 스킵
    stage.executorNote = `${stage.executorNote ? stage.executorNote + '; ' : ''}` +
      `실패(${stage.executor}) → 대체 실행자 '${alt}' 재시도`;
    stage.retryCount = (stage.retryCount ?? 0) + 1;
    stage.executor = alt;
    stage.taskId = null;
    stage.status = 'pending';
    stage.error = undefined;
    touch(run);
    const ok = await dispatchStage(app, run, stage, projectDir);
    if (ok && stage.taskId) await collectStage(app, stage, run);
  }));
}

// 병렬 집계: 성공/실패 카운트 → summary + 터미널 상태(completed/partial/failed).
function finalizeParallel(run: CompanyRun): void {
  const total = run.stages.length;
  const succeeded = run.stages.filter((s) => s.status === 'completed').length;
  const failed = total - succeeded;
  const retried = run.stages.filter((s) => (s.retryCount ?? 0) > 0).length;
  run.summary = { total, succeeded, failed, retried };
  run.status = failed === 0 ? 'completed' : succeeded > 0 ? 'partial' : 'failed';
  if (failed > 0) {
    run.error = `${failed}/${total} 단계 실패: ` +
      run.stages.filter((s) => s.status !== 'completed')
                .map((s) => `${s.teamSlug}(${s.executor})`).join(', ');
  }
  touch(run);
}

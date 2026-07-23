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
import { agentManager } from '../agent/agent-manager.js';
import { createId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';
import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';
import { smartRouter } from './smart-router.js';
import { classifyTier, type Tier } from './tier-policy.js';
import type { TaskType } from './quality-gate.js';
import { acquireComputerUseLease } from './computer-use-company.js';
import { adaptiveScorer } from './adaptive-scorer.js';

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
      const rows = getDb()
        .prepare(`SELECT agent_id FROM rate_limit_state WHERE is_limited=1`)
        .all() as Array<{ agent_id: string }>;
      for (const r of rows) limited.add(r.agent_id);
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
  | 'dispatched' | 'completed' | 'failed' | 'partial';
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
  createdAt: string;
  updatedAt: string;
  decomposer: string | null;   // 분해 담당 LLM(실제 사용된 agent)
  decomposeSource: 'llm' | 'template' | null;
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

export function rankTeam(team: TeamRow): number {
  // 기술 이식 회사는 안전→복구→측정→가치판단→이식의 고정 순서가
  // 역할 키워드보다 중요하다. 전용 slug 번호를 명시적 stage rank로 사용한다.
  const technologyPortStage = team.slug.match(/^tech-port-(\d{2})-/);
  if (technologyPortStage) return Number(technologyPortStage[1]);
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

// 팀의 실행자 해석: (가용한) lead → (가용한) 첫 member → fallback.
// isAvailable 미지정 시 "등록 여부"만 본다(테스트 호환). 지정 시 리밋/차단된 provider 제외.
export function resolveExecutor(
  team: TeamRow,
  knownAgents: Set<string>,
  fallback = 'ollama',
  isAvailable: AvailabilityFn = (id) => knownAgents.has(id),
): string {
  if (team.lead && isAvailable(team.lead)) return team.lead;
  const m = team.members.find((ref) => isAvailable(ref));
  if (m) return m;
  if (isAvailable(fallback)) return fallback;
  // 전원 차단 시: 등록된 lead/멤버라도 반환(디스패치는 /api/task failover 가 재시도).
  if (team.lead && knownAgents.has(team.lead)) return team.lead;
  const km = team.members.find((ref) => knownAgents.has(ref));
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
  if (team.lead && isAvailable(team.lead)) push(team.lead);
  for (const ref of team.members) if (isAvailable(ref)) push(ref);
  if (isAvailable(fallback)) push(fallback);
  push(team.lead);
  for (const ref of team.members) push(ref);
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
  if (!specific) return templateSubtask(team, goal);
  return [
    `[회사 목표] ${goal}`,
    ``,
    `[팀 하위작업: ${team.name}]`,
    specific,
    ``,
    `위 하위작업은 회사 목표의 대상·안전 제약·산출물 경로를 그대로 준수해야 합니다.`,
  ].join('\n');
}

// 기술 이식 회사는 팀 밖의 범용/저신뢰 executor로 재위임하지 않는다.
// 단계별 failover는 runStageWithFailover가 조직에 등록된 팀원 체인 안에서 수행한다.
export function allowQueueProviderFailover(orgSlug: string): boolean {
  return orgSlug !== 'technology-porting';
}

// ── 실행 상태 저장소(인메모리, LRU 상한) ───────────────────────────────
const RUNS = new Map<string, CompanyRun>();
const MAX_RUNS = 200;

function putRun(run: CompanyRun): void {
  RUNS.set(run.id, run);
  while (RUNS.size > MAX_RUNS) {
    const oldest = RUNS.keys().next().value;
    if (oldest === undefined) break;
    RUNS.delete(oldest);
  }
}

export function getCompanyRun(runId: string): CompanyRun | null {
  return RUNS.get(runId) ?? null;
}

export function listCompanyRuns(limit = 20): CompanyRun[] {
  return [...RUNS.values()].slice(-limit).reverse();
}

function touch(run: CompanyRun): void {
  run.updatedAt = new Date().toISOString();
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

export function startCompanyRun(app: FastifyInstance, opts: StartRunOptions): CompanyRun {
  const goal = (opts.goal ?? '').trim();
  if (!goal) throw new OrchestrationError(400, 'goal required');
  const mode: OrchestrationMode = opts.mode === 'parallel' ? 'parallel' : 'pipeline';

  const org = loadOrg(opts.orgIdOrSlug);
  const rawTeams = loadTeams(org.id);
  if (rawTeams.length === 0) throw new OrchestrationError(400, `organization has no active teams: ${org.slug}`);
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

  const ordered = orderTeams(rawTeams);
  const known = new Set(agentManager.listEnabledIds());
  const avail = liveAvailability(known);
  const now = new Date().toISOString();

  const decomposerCandidates = resolveDecomposers(org.manager, known, avail);
  const run: CompanyRun = {
    id: createId('corun'),
    orgId: org.id,
    orgName: org.name,
    orgSlug: org.slug,
    goal,
    mode,
    status: 'pending',
    dryRun: opts.dryRun === true,
    createdAt: now,
    updatedAt: now,
    decomposer: decomposerCandidates[0] ?? null,
    decomposeSource: null,
    stages: ordered.map((t) => {
      const executor = resolveExecutor(t, known, 'ollama', avail);
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
  putRun(run);

  // 실행은 비동기로 구동(HTTP 응답을 막지 않음). 파이프라인은 수분 걸릴 수 있음.
  void driveRun(app, run.id, ordered, opts.projectDir, decomposerCandidates).catch((err) => {
    const r = RUNS.get(run.id);
    if (r) { r.status = 'failed'; r.error = err instanceof Error ? err.message : String(err); touch(r); }
    log.error({ err: err instanceof Error ? err.message : String(err), runId: run.id }, 'company run drive failed');
  });

  return run;
}

async function driveRun(app: FastifyInstance, runId: string, teams: TeamRow[], projectDir: string, decomposers: string[]): Promise<void> {
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
      await driveRunBody(app, runId, teams, projectDir, decomposers);
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
  await driveRunBody(app, runId, teams, projectDir, decomposers);
}

async function driveRunBody(app: FastifyInstance, runId: string, teams: TeamRow[], projectDir: string, decomposers: string[]): Promise<void> {
  const run = RUNS.get(runId);
  if (!run) return;
  const teamBySlug = new Map(teams.map((t) => [t.slug, t]));

  // 1) 분해(LLM 매니저) — 후보 프로바이더를 순서대로 시도, 첫 파싱성공 채택.
  //    각 시도 직전 서킷 재확인(그 사이 리밋 걸린 provider 즉시 스킵) + 하드 타임아웃 race
  //    (executeTask 내부 abort 가 늦어도 후보 넘어가도록).
  run.status = 'decomposing'; touch(run);
  let decomposition: Record<string, string> | null = null;
  const prompt = buildDecompositionPrompt(run.orgName, run.goal, teams);
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
  touch(run);

  // 2.5) 역량 기반 실행자 재선정 — subtask 확정 후 dispatch 전, 깨진/제거 lead 를 무시하고
  //      subtask 유형(inferTaskType)으로 현재 가용 프로바이더 중 최적 실행자 재배정.
  //      lead 가 유효·가용하면 팀 설계 존중해 유지. 분해 대기 이후 fresh availability 사용.
  const knownNow = new Set(agentManager.listEnabledIds());
  const availNow = liveAvailability(knownNow);
  for (const stage of run.stages) {
    const team = teamBySlug.get(stage.teamSlug)!;
    const before = stage.executor;
    const sel = reselectExecutor(team, stage.subtask ?? '', knownNow, 'ollama', availNow);
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
  for (run.iteration = 1; run.iteration <= MAX_RUN_ITERATIONS; run.iteration++) {
    // REFINE: 2회차부터 미완료 단계 실행자 재선정(서킷/리밋 회복 반영) + 상태 초기화
    if (run.iteration > 1) {
      const k = new Set(agentManager.listEnabledIds());
      const a = liveAvailability(k);
      for (const stage of run.stages) {
        if (stage.status === 'completed') continue;
        const team = teamBySlug.get(stage.teamSlug)!;
        const sel = reselectExecutor(team, baseSubtasks.get(stage.teamSlug) ?? '', k, 'ollama', a);
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

    // VERIFY: 전 단계 완료면 성공 확정하고 루프 종료
    const safelyRejected = run.orgSlug === 'technology-porting' && run.portDecision === 'reject';
    if (run.stages.every((s) => s.status === 'completed' || (safelyRejected && s.status === 'skipped'))) {
      run.status = 'completed';
      run.summary = summarizeRun(run);
      touch(run);
      return;
    }

    // 미완료 → 다음 반복(서킷 회복 대기). 마지막 반복이면 루프 탈출.
    if (run.iteration < MAX_RUN_ITERATIONS) {
      run.status = 'running'; touch(run);
      log.warn({ runId, iteration: run.iteration,
        incomplete: run.stages.filter((s) => s.status !== 'completed').map((s) => s.teamSlug) },
        'loop-engine: iteration incomplete — refining executors and retrying');
      await sleep(LOOP_BACKOFF_MS);
    }
  }

  // MAX 반복 후에도 미완료 → partial/failed 확정
  finalizeRun(run);
}

// 파이프라인 1회 실행(미완료 단계만). completed 단계는 산출물만 handoff 소스로 사용하고 건너뜀.
// 한 단계가 failover 소진으로 실패하면 즉시 반환(루프 앤진이 다음 반복에서 재시도).
async function executePipelineOnce(
  app: FastifyInstance, run: CompanyRun,
  teamBySlug: Map<string, TeamRow>, projectDir: string, baseSubtasks: Map<string, string>,
): Promise<void> {
  run.status = 'running'; touch(run);
  let prev: RunStage | null = null;
  for (let s = 0; s < run.stages.length; s++) {
    const stage = run.stages[s];
    if (stage.status === 'completed') { prev = stage; continue; } // 이미 완료 — handoff 소스로만
    const team = teamBySlug.get(stage.teamSlug)!;
    let subtask = baseSubtasks.get(stage.teamSlug) ?? '';
    if (prev?.outputSnippet) {
      subtask = `[이전 단계 '${prev.teamName}' 산출물]\n${prev.outputSnippet}\n\n---\n${subtask}`;
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
  run.status = 'dispatching'; touch(run);
  const pKnown = new Set(agentManager.listEnabledIds());
  const pAvail = liveAvailability(pKnown);
  const pending = run.stages.filter((s) => s.status !== 'completed');
  for (const stage of pending) {
    stage.subtask = baseSubtasks.get(stage.teamSlug) ?? stage.subtask;
    const team = teamBySlug.get(stage.teamSlug)!;
    const chain = resolveExecutorChain(team, pKnown, 'ollama', pAvail);
    const seeded = stage.executor && pKnown.has(stage.executor)
      ? [stage.executor, ...chain.filter((x) => x !== stage.executor)]
      : chain;
    for (const c of seeded) { if (await providerModelDispatchable(c)) { stage.executor = c; break; } }
    await dispatchStage(app, run, stage, projectDir);
    await sleep(PARALLEL_STAGGER_MS);
  }
  run.status = 'running'; touch(run);
  await Promise.all(pending.map((stage) => collectStage(stage, run)));
  await retryFailedStagesParallel(app, run, teamBySlug, projectDir);
}

function summarizeRun(run: CompanyRun): { total: number; succeeded: number; failed: number; retried: number; skipped?: number } {
  const total = run.stages.length;
  const succeeded = run.stages.filter((s) => s.status === 'completed').length;
  const skipped = run.stages.filter((s) => s.status === 'skipped').length;
  const retried = run.stages.filter((s) => (s.retryCount ?? 0) > 0 || (s.attempt ?? 1) > 1).length;
  return { total, succeeded, failed: total - succeeded - skipped, retried, ...(skipped ? { skipped } : {}) };
}

// 루프 소진 후 최종 상태 확정(completed/partial/failed).
function finalizeRun(run: CompanyRun): void {
  run.summary = summarizeRun(run);
  const failed = run.summary.failed;
  run.status = failed === 0 ? 'completed' : run.summary.succeeded > 0 ? 'partial' : 'failed';
  if (failed > 0) {
    run.error = `루프 ${run.iteration ?? MAX_RUN_ITERATIONS}회 후 ${failed}/${run.summary.total} 미완료: ` +
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
  const roleChain = resolveExecutorChain(team, known, 'ollama', avail);
  // cap-3 역량 재선정으로 세팅된 stage.executor 를 attempt#1 로 seed(등록된 경우).
  const seeded = stage.executor && known.has(stage.executor)
    ? [stage.executor, ...roleChain.filter((x) => x !== stage.executor)]
    : roleChain;
  // R3 모델검증 통과 후보만, 최대 MAX_STAGE_ATTEMPTS
  const chain: string[] = [];
  for (const id of seeded) {
    if (await providerModelDispatchable(id)) chain.push(id);
    if (chain.length >= MAX_STAGE_ATTEMPTS) break;
  }
  const candidates = chain.length ? chain : [stage.executor];
  const baseSubtask = stage.subtask ?? '';
  let lastError = '';
  for (let i = 0; i < candidates.length; i++) {
    const exec = candidates[i];
    if (i > 0 && !avail(exec)) { lastError = `${exec} unavailable`; continue; }
    stage.executor = exec;
    stage.subtask = baseSubtask;
    stage.attempt = i + 1;
    stage.taskId = null;
    const ok = await dispatchStage(app, run, stage, projectDir);
    if (!ok || !stage.taskId) { lastError = stage.error ?? `${exec} dispatch failed`; continue; }
    stage.status = 'running'; touch(run);
    const result = await waitForTask(stage.taskId, PIPELINE_STAGE_TIMEOUT_MS);
    stage.status = (result.status as StageStatus) ?? 'failed';
    stage.outputSnippet = (result.response ?? '').slice(0, PIPELINE_HANDOFF_CHARS);
    stage.outputChars = (result.response ?? '').length;
    touch(run);
    // 최종 stage 는 하류 캐스케이드가 없으므로 substantive 게이트 예외(완성률 순손실 방지).
    const substantive = isLastStage || isSubstantiveOutput(result.response);
    if (result.status === 'completed' && substantive) {
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
  stage.status = 'failed';
  stage.error = `all executors failed: ${lastError}`;
  return false;
}

// 단일 팀 태스크 dispatch(inject POST /api/task + team_id 태그). 성공 시 true.
async function dispatchStage(app: FastifyInstance, run: CompanyRun, stage: RunStage, projectDir: string): Promise<boolean> {
  try {
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
  if (!provider) return false; // 제거된 lead(mlx3/copilot3 등) → 즉시 배제
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
const PIPELINE_STAGE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_STAGE_ATTEMPTS = 3;            // 순차 단계 failover: 초기 1 + 대체 2회
const PARALLEL_STAGE_TIMEOUT_MS = 15 * 60 * 1000; // 병렬 단계당 완료 대기 상한
const PARALLEL_STAGGER_MS = 400;         // dispatch 스태거(로컬 단일스레드 보호)
const MAX_RUN_ITERATIONS = 5;            // 루프 앤진: 완료-루프 최대 반복(닫힌 자기교정)
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
async function waitForTask(taskId: string, timeoutMs: number): Promise<{ status: string; response: string | null }> {
  const db = getDb();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = db.prepare(`SELECT status, response FROM tasks WHERE id=?`).get(taskId) as
      { status: string | null; response: string | null } | undefined;
    const status = row?.status ?? 'failed';
    if (!row) return { status: 'failed', response: null };
    if (TERMINAL.has(status)) return { status, response: row.response ?? null };
    if (Date.now() >= deadline) return { status: 'timed_out', response: row.response ?? null };
    await sleep(POLL_MS);
  }
}

// 단일 단계 결과 수집: 완료 대기 → 산출물/상태 기록 → 빈 산출물 게이트.
async function collectStage(stage: RunStage, run: CompanyRun): Promise<void> {
  if (!stage.taskId) return; // dispatch 실패 — status 이미 'failed'
  stage.status = 'running'; touch(run);
  const result = await waitForTask(stage.taskId, PARALLEL_STAGE_TIMEOUT_MS);
  stage.outputSnippet = (result.response ?? '').slice(0, PIPELINE_HANDOFF_CHARS);
  stage.outputChars = (result.response ?? '').length;
  if (result.status === 'completed' && isSubstantiveOutput(result.response)) {
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
  const failed = run.stages.filter((s) => s.status !== 'completed' && (s.retryCount ?? 0) < 1);
  if (failed.length === 0) return;
  const known = new Set(agentManager.listEnabledIds());
  const avail = liveAvailability(known);
  await Promise.all(failed.map(async (stage) => {
    const team = teamBySlug.get(stage.teamSlug);
    if (!team) return;
    const chain = resolveExecutorChain(team, known, 'ollama', avail);
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
    if (ok && stage.taskId) await collectStage(stage, run);
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

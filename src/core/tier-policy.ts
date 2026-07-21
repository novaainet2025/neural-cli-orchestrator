/**
 * tier-policy.ts — Brain(유료 스마트) / Worker(무료 로컬) 2계층 오케스트레이션 정책
 * ------------------------------------------------------------------------------
 * 사용자 지시(2026-07-03): "가장 똑똑한 유료 프로바이더 = 두뇌(계획·설계·리뷰·검증·종합),
 * 무료 로컬 LLM = 워커(대량 구현·기계적 작업). 이 조합으로 최대 퍼포먼스."
 *
 * 이 파일은 계층 배정의 **단일 소스**다. commander.ts / smart-router.ts 가 모두 여기를
 * 참조한다. 새로운 라우팅 코드도 반드시 여기를 경유할 것 (하드코딩 금지).
 *
 * 최대 퍼포먼스 원리 (orchestrator-workers):
 *   1) 두뇌(유료 1개)가 태스크를 잘게 분해·설계          → 품질 높은 계획
 *   2) 워커(무료 로컬 N개)가 서브태스크를 병렬 구현        → 저비용·고처리량
 *   3) 두뇌가 통합·리뷰·검증                              → 품질 보증
 */

export type Tier = 'brain' | 'worker';

/**
 * 두뇌(BRAIN) — 유료·최고 지능. 계획/아키텍처/리뷰/검증판단/종합/전략.
 * 능력 우선순위 내림차순 (claude-code=Opus 최상위).
 */
export const BRAIN_TIER: readonly string[] = [
  'claude-code',  // Opus — Commander/최종 종합
  'opencode',     // Architect — 설계·구조
  'cursor-agent', // Reviewer — 코드 리뷰·보안
  'codex',        // Engineer(paid) — 어려운 구현 escalation
  'agy',          // Designer — UI·패턴
];

/**
 * 워커(WORKER) — 무료·로컬 우선. 대량 구현/기계적/병렬 작업.
 * 로컬(ollama) 우선 → 무료 클라우드(nvidia/openrouter) fallback.
 * ※ hermes는 2026-07-18 codex CLI(paid)로 전환되어 무료·로컬 계약에서 제외.
 *   직접 위임(nco_task ai=hermes)·failover 타깃으로는 계속 사용 가능.
 * ※ mlx는 2026-07-21 완전제거(사용자 지시) — 로컬 워커는 Ollama 단일화.
 */
export const WORKER_TIER: readonly string[] = [
  'ollama',       // 로컬 Ollama (qwen3:30b-a3b)
  'aider',        // 무료 (aider CLI)
  'nvidia',       // 무료 클라우드 Reasoner
];

const BRAIN_SET = new Set(BRAIN_TIER);
const WORKER_SET = new Set(WORKER_TIER);

/** 프로바이더 id의 계층 판별. */
export function tierOf(id: string): Tier | 'unknown' {
  if (BRAIN_SET.has(id)) return 'brain';
  if (WORKER_SET.has(id)) return 'worker';
  return 'unknown';
}

// 두뇌급 의도: 판단·설계·검토가 필요한 작업 → 유료 스마트
const BRAIN_INTENT =
  /(설계|아키텍처|architecture|design|계획|planning|\bplan\b|리뷰|review|검토|판단|decision|의사결정|종합|synthesi[sz]e?|분해|decompose|전략|strategy|취약|보안|security|audit|평가|evaluate|trade[- ]?off|근본원인|root cause)/i;
// 워커급 의도: 대량·기계적 실행 작업 → 무료 로컬
const WORKER_INTENT =
  /(구현|implement|코드\s*생성|generate|작성|스캐폴드|scaffold|보일러플레이트|boilerplate|수정\s*적용|apply|리팩토링\s*적용|테스트\s*생성|테스트\s*작성|번역|translate|포맷|format|정리|대량|bulk|반복|repeat|일괄|batch|마이그레이션\s*실행)/i;

/**
 * 태스크를 두뇌급/워커급으로 분류. 의도 키워드 우선, 없으면 복잡도로 판정.
 * @param complexity 1-10 (smart-router.analyzeComplexity 결과)
 */
export function classifyTier(prompt: string, complexity: number): Tier {
  if (BRAIN_INTENT.test(prompt)) return 'brain';
  if (WORKER_INTENT.test(prompt)) return 'worker';
  return complexity >= 7 ? 'brain' : 'worker';
}

/**
 * 후보 id 목록을 지정 tier 우선순위로 정렬한다.
 * primary tier 를 앞으로, 반대 tier 를 fallback 으로, 미지의 것은 맨 뒤로.
 */
export function orderByTier(ids: string[], tier: Tier): string[] {
  const primary = tier === 'brain' ? BRAIN_TIER : WORKER_TIER;
  const secondary = tier === 'brain' ? WORKER_TIER : BRAIN_TIER;
  const rank = (id: string): number => {
    const pi = primary.indexOf(id);
    if (pi !== -1) return pi; // 0..
    const si = secondary.indexOf(id);
    if (si !== -1) return 100 + si; // 100..
    return 999; // unknown 맨 뒤
  };
  return [...ids].sort((a, b) => rank(a) - rank(b));
}

/**
 * Commander 4-Layer 계층별 에이전트 배정 (tier 정책 반영).
 * pickAvailableAgent 가 앞에서부터 사용가능한 것을 고르므로 순서 = 우선순위 + fallback.
 */
export const LAYER_TIER_AGENTS: Record<string, string[]> = {
  // 두뇌: 계획·최종 종합 (유료 스마트)
  management: ['claude-code', 'opencode'],
  // 두뇌 리서치 + 무료 fallback
  information: ['nvidia'],
  // 워커: 무료 전체를 로컬우선→무료클라우드 순으로 나열(WORKER_TIER 그대로 재사용).
  // 머신에 로컬 LLM이 없으면(저사양 원격: subnote/kangnote 등) ollama가
  // enabled 안 돼 자동으로 무료 클라우드(nvidia/openrouter)로 폴백, 무료가 전무하면
  // codex(유료)로 escalation. pickAvailableAgent가 enabled+circuit로 필터하므로
  // 머신별 자동 적응 — 하드코딩 없이 사양별 유연 배정 ([[feedback_ollama_lowspec_exclude]]).
  execution: [...WORKER_TIER, 'codex'],
  // 두뇌 리뷰 + 무료 QA fallback
  quality: ['cursor-agent', 'ollama', 'nvidia'],
};

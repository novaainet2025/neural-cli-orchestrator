/**
 * NCO Context Budget Guard — 토큰 회계 + 컨텍스트 예산 관리
 *
 * 이식 출처: opencode-swarm (P2-13 Context Budget Guard)
 *
 * 목적:
 *   에이전트 오케스트레이션 중 누적되는 컨텍스트(plan, 응답, 관찰 등)의 토큰
 *   사용량을 태스크별로 추적하고, 예산 한도 초과를 사전에 감지하여 압축(compaction)
 *   시점을 결정한다. 외부 LLM 호출 없이 순수·결정론적으로 동작하므로 테스트 가능하다.
 *
 * 핵심 기능:
 *   - estimateTokens(text)      : 대략 문자수/4 휴리스틱
 *   - summarize(text, ...)      : 결정론적 요약 (앞/뒤 발췌 + '…[N chars omitted]…')
 *   - compressPlan(text)        : plan을 ~1500 토큰으로 압축, 100KB 초과는 요약본 대체
 *   - ContextBudget 클래스       : 태스크별 사용량 추적 + 임계/초과 감지
 */

/** 기본 컨텍스트 예산 한도 (토큰). */
export const DEFAULT_BUDGET_TOKENS = 128_000;

/** shouldCompact()가 true를 반환하기 시작하는 사용률 임계값. */
export const DEFAULT_COMPACT_THRESHOLD = 0.8;

/** compressPlan() 목표 압축 크기 (토큰). */
export const COMPRESS_TARGET_TOKENS = 1_500;

/** 이 문자수를 초과하는 plan 텍스트는 무조건 요약본으로 대체한다 (100KB). */
export const MAX_PLAN_CHARS = 100_000;

/** 토큰 1개당 대략 문자수 (문자수/4 휴리스틱). */
const CHARS_PER_TOKEN = 4;

/** 요약 시 앞부분(head)에 할당하는 비율. 나머지는 뒷부분(tail). */
const HEAD_RATIO = 0.6;

/**
 * 텍스트의 대략적인 토큰 수를 추정한다.
 * 문자수/4 휴리스틱 — 영어/코드 기준 러프한 근사치.
 * 빈 문자열은 0, 그 외에는 최소 1 토큰을 보장한다.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

export interface SummarizeOptions {
  /** 요약 결과의 목표 문자 수. 기본값은 COMPRESS_TARGET_TOKENS * CHARS_PER_TOKEN. */
  targetChars?: number;
  /** head 비율 (0~1). 기본 0.6. */
  headRatio?: number;
}

/**
 * 결정론적 요약 — 외부 LLM 없이 앞/뒤 발췌 + 생략 마커로 축약한다.
 *
 * text 길이가 targetChars 이하이면 원본을 그대로 반환한다.
 * 초과하면 앞부분(head)과 뒷부분(tail)을 잘라내고 그 사이에
 * `…[N chars omitted]…` 마커를 삽입한다.
 *
 * 동일 입력에 대해 항상 동일 출력 → 테스트 가능.
 */
export function summarize(text: string, options: SummarizeOptions = {}): string {
  const targetChars = options.targetChars ?? COMPRESS_TARGET_TOKENS * CHARS_PER_TOKEN;
  const headRatio = options.headRatio ?? HEAD_RATIO;

  if (targetChars <= 0) {
    // 예산이 0 이하이면 전체를 생략한 마커만 반환한다.
    return `…[${text.length} chars omitted]…`;
  }
  if (text.length <= targetChars) {
    return text;
  }

  const headChars = Math.max(0, Math.floor(targetChars * headRatio));
  const tailChars = Math.max(0, targetChars - headChars);
  const omitted = text.length - headChars - tailChars;

  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(text.length - tailChars) : '';

  return `${head}\n…[${omitted} chars omitted]…\n${tail}`;
}

/**
 * plan 텍스트를 ~1500 토큰(≈6000자)으로 압축한다.
 *
 * - 100KB(MAX_PLAN_CHARS) 초과 텍스트는 무조건 요약본으로 대체한다.
 * - 그 외에도 목표 토큰(COMPRESS_TARGET_TOKENS)을 초과하면 요약한다.
 * - 목표 이하이면 원본을 그대로 반환한다.
 */
export function compressPlan(text: string): string {
  const targetChars = COMPRESS_TARGET_TOKENS * CHARS_PER_TOKEN;

  // 100KB 초과 또는 목표 토큰 초과 시 요약본으로 대체.
  if (text.length > MAX_PLAN_CHARS || estimateTokens(text) > COMPRESS_TARGET_TOKENS) {
    return summarize(text, { targetChars });
  }
  return text;
}

export interface ContextBudgetOptions {
  /** 예산 한도 (토큰). 기본 128k. */
  limit?: number;
  /** 압축 임계 사용률 (0~1). 기본 0.8. */
  compactThreshold?: number;
}

/** 태스크별 토큰 사용 내역. */
export interface TaskUsage {
  taskId: string;
  tokens: number;
}

/**
 * ContextBudget — 태스크별 토큰 사용량 추적 + 예산 한도 관리.
 *
 * 사용 예:
 *   const budget = new ContextBudget({ limit: 128_000 });
 *   budget.addText('plan', planText);      // 텍스트를 추정하여 누적
 *   budget.add('response', 3200);          // 이미 아는 토큰 수를 직접 누적
 *   if (budget.shouldCompact()) { ...compact... }
 */
export class ContextBudget {
  readonly limit: number;
  readonly compactThreshold: number;
  private readonly usage = new Map<string, number>();

  constructor(options: ContextBudgetOptions = {}) {
    const limit = options.limit ?? DEFAULT_BUDGET_TOKENS;
    const threshold = options.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;

    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`ContextBudget: limit must be a positive number, got ${limit}`);
    }
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
      throw new Error(`ContextBudget: compactThreshold must be in (0, 1], got ${threshold}`);
    }

    this.limit = limit;
    this.compactThreshold = threshold;
  }

  /**
   * 태스크에 토큰 수를 직접 누적한다. 동일 taskId는 합산된다.
   * 음수 토큰은 거부한다.
   * @returns 누적 후 해당 태스크의 총 토큰 수
   */
  add(taskId: string, tokens: number): number {
    if (!Number.isFinite(tokens) || tokens < 0) {
      throw new Error(`ContextBudget.add: tokens must be a non-negative number, got ${tokens}`);
    }
    const next = (this.usage.get(taskId) ?? 0) + tokens;
    this.usage.set(taskId, next);
    return next;
  }

  /**
   * 텍스트를 추정하여 태스크에 누적한다 (add + estimate 조합).
   * @returns 이번에 추가된 추정 토큰 수
   */
  addText(taskId: string, text: string): number {
    const tokens = estimateTokens(text);
    this.add(taskId, tokens);
    return tokens;
  }

  /** 텍스트의 추정 토큰 수를 반환한다 (상태 변경 없음). */
  estimate(text: string): number {
    return estimateTokens(text);
  }

  /** 특정 태스크의 누적 토큰 수. 없으면 0. */
  usageOf(taskId: string): number {
    return this.usage.get(taskId) ?? 0;
  }

  /** 전체 누적 토큰 수. */
  total(): number {
    let sum = 0;
    for (const tokens of this.usage.values()) sum += tokens;
    return sum;
  }

  /** 남은 예산 (토큰). 음수가 되지 않도록 0에서 클램프. */
  remaining(): number {
    return Math.max(0, this.limit - this.total());
  }

  /** 현재 사용률 (0~). 한도 초과 시 1을 넘을 수 있다. */
  utilization(): number {
    return this.total() / this.limit;
  }

  /** 예산 한도 초과 여부. */
  isOverBudget(): boolean {
    return this.total() > this.limit;
  }

  /**
   * 압축이 필요한지 여부.
   * 사용률이 compactThreshold 이상이면 true.
   */
  shouldCompact(): boolean {
    return this.utilization() >= this.compactThreshold;
  }

  /** 태스크별 사용 내역 스냅샷 (읽기 전용 배열). */
  breakdown(): TaskUsage[] {
    return Array.from(this.usage.entries()).map(([taskId, tokens]) => ({ taskId, tokens }));
  }

  /** 모든 사용 내역 초기화. */
  reset(): void {
    this.usage.clear();
  }
}

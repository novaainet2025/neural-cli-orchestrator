import { agentManager } from '../agent/agent-manager.js';
import { sharedState } from './shared-state.js';
import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';
import type { TaskType } from './quality-gate.js';

const log = createLogger('smart-router');

type DiscussionMode = 'task' | 'parallel' | 'discussion' | 'consensus' | 'hive' | 'broadcast' | 'commander'
  | 'nova-ax' | 'company' | 'team-project' | 'full-pipeline'
  | 'mesh' | 'inter-session';

interface RouteDecision {
  mode: DiscussionMode;
  providers: string[];
  complexity: number;
  reasoning: string;
  meta?: Record<string, string>;  // 모드별 추가 파라미터 (target, message 등)
}

// Keyword → mode trigger map (우선순위: 위쪽이 먼저 매칭)
const KEYWORD_TRIGGERS: Array<{ pattern: RegExp; mode: DiscussionMode; minAI: number }> = [
  { pattern: /mithosis|미쏘스|미토시스/i, mode: 'parallel', minAI: 4 },

  // ── 신규: Mesh 모드 (세션 간 브로드캐스트/그룹 메시지) ─────────────────
  { pattern: /mesh\s*(broadcast|전체|메시지|알림)|모든\s*세션|전체\s*에이전트.*전달|세션\s*전체.*공지/i, mode: 'mesh', minAI: 1 },

  // ── 신규: Inter-Session 모드 (특정 세션/에이전트에 직접 메시지) ──────────
  { pattern: /inter[-\s]?session|다른\s*세션|세션\s*간|다른\s*claude|peer\s*에이전트|claude[-\s]?\d+에게|세션.*전달|세션.*메시지|다른.*에이전트에게/i, mode: 'inter-session', minAI: 1 },

  // ── 신규: Nova-AX 모드 ──────────────────────────────────────────────────
  { pattern: /nova[-\s]?ax|직원|출퇴근|근태|캠|cam\b|insta360|auraface|얼굴.*인식|출입/i, mode: 'nova-ax', minAI: 1 },

  // ── 신규: Full-Pipeline 모드 (기획→검증 7단계) ─────────────────────────
  { pattern: /처음부터|기획부터.*검증|전체.*파이프라인|a\s*to\s*z|end[-\s]?to[-\s]?end|전체.*과정|처음.*끝/i, mode: 'full-pipeline', minAI: 5 },

  // ── 신규: Company 모드 ─────────────────────────────────────────────────
  { pattern: /회사.*만들|조직.*구성|부서.*만들|팀장.*배정|기획부터.*배포|기획.*설계.*구현.*배포/i, mode: 'company', minAI: 4 },

  // ── 신규: Team-Project 모드 ───────────────────────────────────────────
  { pattern: /팀\s*만들|그룹\s*만들|협업\s*팀|역할\s*분담|팀\s*프로젝트|team.*project|프로젝트.*팀/i, mode: 'team-project', minAI: 3 },

  // ── 기존 트리거 ───────────────────────────────────────────────────────
  { pattern: /여러\s*에이전트|동시에\s*작업|동시에.*(?:리뷰|분석|처리|수행)|병렬.*실행|모두.*동시/i, mode: 'parallel', minAI: 3 },
  { pattern: /앙상블|ensemble|best.?of.?n|최적.*결과.*선택|여러\s*모델.*비교/i, mode: 'parallel', minAI: 3 },
  { pattern: /아키텍처|architecture|설계|design/i, mode: 'discussion', minAI: 3 },
  { pattern: /보안|security|vulnerability|취약/i, mode: 'parallel', minAI: 2 },
  { pattern: /프로덕션|deploy|release|배포/i, mode: 'consensus', minAI: 3 },
  { pattern: /리뷰|review|검토|코드리뷰/i, mode: 'discussion', minAI: 2 },
  { pattern: /리팩토링|refactor/i, mode: 'discussion', minAI: 2 },
  { pattern: /최적화|performance|성능/i, mode: 'parallel', minAI: 2 },
  { pattern: /테스트|test/i, mode: 'parallel', minAI: 2 },
  { pattern: /긴급|critical|hotfix/i, mode: 'consensus', minAI: 2 },
  { pattern: /전체|all|모든|종합/i, mode: 'hive', minAI: 9 },
  { pattern: /토론|debate|discuss/i, mode: 'discussion', minAI: 3 },
  { pattern: /이미지|영상|비디오|미디어|image|video|media|generate.*image|generate.*video|그려|만들어.*이미지|만들어.*영상/i, mode: 'task', minAI: 1 },
];

// ── 프롬프트에서 inter-session 타겟 및 메시지 추출 ─────────────────────
export function extractInterSessionMeta(prompt: string): Record<string, string> {
  // 타겟 에이전트 추출: "claude-1에게", "claude-2로", "nova-macui-claude-3에게"
  const targetMatch = prompt.match(/([a-z0-9][a-z0-9-]{1,39})\s*(?:에게|한테|로|에게\s*전달|에게\s*보내)/i);
  // 메시지 본문 추출: "에게" 이후 내용
  const msgMatch = prompt.match(/(?:에게|한테|로)\s*['""]?(.+)['""]?\s*$/i) ||
                   prompt.match(/(?:전달|메시지|보내)[:\s]+['""]?(.+)['""]?$/i);
  return {
    target: targetMatch?.[1]?.toLowerCase() ?? '',
    message: msgMatch?.[1]?.trim() ?? prompt,
  };
}

// Role → preferred agents map (성공률 기반 — 2026-06-15 업데이트)
const ROLE_MAP: Record<string, string[]> = {
  management: ['opencode', 'cursor-agent'],      // claude-code 24% → opencode 97.8%
  information: ['copilot', 'opencode'],          // openrouter 42.4% → opencode fallback
  execution: ['codex', 'opencode', 'cursor-agent'],
  quality: ['cursor-agent', 'codex'],            // mlx 76.4% → codex 97.6%
  media: ['higgsfield'],
};

/** Performance-first ordering (2026-06-15 기준 실측 성공률):
 *  cursor-agent 98.2% → opencode 97.8% → codex 97.6% → copilot 94.4%
 *  → agy 100%(소량) → nvidia 79.5% → mlx 76.4%
 *  → openrouter 42.4% → claude-code 24% (Native CLI, 안정성 낮음)
 *
 *  openrouter/claude-code는 fallback 위치로 이동.
 *  ollama: disabled이므로 맨 뒤.
 */
// 성능 기반 순위 (2026-06-15 업데이트):
// 비활성화: ollama(0%), claude-code(24%), openrouter(rate-limited), gemini-deep(33%)
// 활성 에이전트만 포함 — 비활성 에이전트는 fallback에서도 제외
export const PROVIDER_COST_ORDER = [
  'cursor-agent', 'opencode', 'codex', 'copilot', 'agy',
  'nvidia', 'mlx', 'higgsfield', 'hermes', 'openclaw',
];

/** Same ordering as selectProviders — use anywhere we slice the first N enabled agents. */
export function sortProvidersByCostOrder(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const ia = PROVIDER_COST_ORDER.indexOf(a);
    const ib = PROVIDER_COST_ORDER.indexOf(b);
    const sa = ia === -1 ? 999 : ia;
    const sb = ib === -1 ? 999 : ib;
    return sa - sb;
  });
}

/**
 * 최근 N건 태스크 성공률 기반 에이전트 가중치 조회.
 * 실패율 30% 초과 에이전트는 페널티 부여.
 */
export function getProviderSuccessWeight(agentId: string, recentN = 20): number {
  try {
    const { getDb } = require('../storage/database.js');
    const db = getDb();
    const rows = db.prepare(`
      SELECT status FROM tasks
      WHERE assigned_to = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(agentId, recentN) as any[];
    if (rows.length < 3) return 1.0; // 데이터 부족 → 기본 가중치
    const ok = rows.filter((r: any) => r.status === 'completed').length;
    const rate = ok / rows.length;
    // 성공률 90%+ → 1.2x 보너스, 50% 미만 → 0.5x 페널티
    if (rate >= 0.9) return 1.2;
    if (rate >= 0.7) return 1.0;
    if (rate >= 0.5) return 0.8;
    return 0.5;
  } catch { return 1.0; }
}

class SmartRouter {
  /**
   * Analyze prompt complexity on a 1-10 scale.
   */
  analyzeComplexity(prompt: string): number {
    let score = 3; // baseline

    // Length factor
    const words = prompt.split(/\s+/).length;
    if (words > 200) score += 2;
    else if (words > 100) score += 1;

    // Code presence
    if (/```/.test(prompt)) score += 1;

    // Multiple requirements (numbered lists, bullet points)
    const listItems = (prompt.match(/^\s*[-*\d.]+\s/gm) || []).length;
    if (listItems >= 5) score += 2;
    else if (listItems >= 3) score += 1;

    // Technical keywords
    const techTerms = (prompt.match(/(api|database|auth|deploy|migration|refactor|security|architecture|performance)/gi) || []).length;
    if (techTerms >= 3) score += 2;
    else if (techTerms >= 1) score += 1;

    // Question complexity
    if (/어떻게.*할까|how should|what's the best/i.test(prompt)) score += 1;

    return Math.min(Math.max(score, 1), 10);
  }

  /**
   * Select the best execution mode based on complexity and keywords.
   */
  selectMode(prompt: string, complexity: number): DiscussionMode {
    // Keyword triggers override complexity-based selection
    for (const trigger of KEYWORD_TRIGGERS) {
      if (trigger.pattern.test(prompt)) {
        return trigger.mode;
      }
    }

    // Complexity-based mode selection
    // NOTE: full-pipeline/company/team-project은 키워드 트리거로만 진입 (복잡도 자동 진입 금지 —
    //       "처음부터"/"기획부터" 없이 복잡도 8인 일반 요청을 7단계 파이프라인으로 보내면 과부하)
    if (complexity <= 5) return 'task';
    if (complexity <= 6) return 'parallel';
    if (complexity <= 8) return 'discussion';
    if (complexity <= 9) return 'commander';  // 복잡도 9 → commander
    return 'hive';                             // 복잡도 10 → 전체 hive
  }

  /**
   * Keyword-based preferred provider for task mode (single-agent).
   * Returns the best-fit provider id for the prompt, or null to fall back to cost order.
   */
  private preferredTaskProvider(prompt: string): string | null {
    // 이미지/영상 생성 → higgsfield (mithosis보다 우선: "이미지 생성: NCO 오케스트레이션" 같은 프롬프트 처리)
    if (/이미지\s*생성|그려\s*줘|generate.*image|create.*image|make.*image|영상\s*생성|비디오\s*생성|시각화.*이미지|이미지.*시각화/i.test(prompt)) return 'higgsfield';
    if (/^이미지|^영상|^비디오/i.test(prompt)) return 'higgsfield';
    // 멀티에이전트 오케스트레이션/메타 작업 → mithosis
    if (/mithosis|미쏘스|미토시스|meta.?orchestr|오케스트레이션|self.?reinforcement|dynamic.?skills/i.test(prompt)) return 'mithosis';
    // 이미지/영상 (일반) → higgsfield
    if (/이미지|영상|비디오|그려|image|video|media/i.test(prompt)) return 'higgsfield';
    // UI/디자인 → agy
    if (/UI|UX|프론트엔드|대시보드|화면|인터페이스|디자인|frontend|dashboard|interface/i.test(prompt)) return 'agy';
    // 코딩/구현/버그 → codex
    if (/구현|수정|버그|코드|fix|implement|build|작성|추가|개발/i.test(prompt)) return 'codex';
    // 설계/아키텍처 → opencode
    if (/설계|아키텍처|design|architecture|구조/i.test(prompt)) return 'opencode';
    // 리뷰/보안 → cursor-agent
    if (/리뷰|review|보안|검토|security/i.test(prompt)) return 'cursor-agent';
    // 검증/테스트 → cursor-agent (ollama는 disabled, cursor-agent 98.2%)
    if (/검증|verify|test|테스트/i.test(prompt)) return 'cursor-agent';
    // Nova-AX 관련 → codex (claude-code 성공률 24%, codex 97.6%)
    if (/nova.?ax|직원|출퇴근|근태|cam\b/i.test(prompt)) return 'codex';
    // 브라우저 자동화/크롤링/스케줄링/메시징 → openclaw
    if (/브라우저\s*자동화|웹\s*크롤|scraping|크롤링|crawl|playwright|selenium|browser.*automat|폼\s*작성|form.*fill|openclaw|웹\s*자동화|사이트.*접속|스케줄.*예약|스케줄링|booking|예약|일정.*등록|이메일.*발송|메시지.*전송.*플랫폼/i.test(prompt)) return 'openclaw';
    // 도구 사용/MCP/function-call/웹검색/파일관리/자기개선 → hermes
    if (/도구\s*사용|tool\s*use|function\s*call|MCP\s*도구|API\s*호출|함수\s*호출|hermes|웹\s*검색.*실행|파일\s*관리|코드\s*실행.*도구|자동화.*도구|멀티\s*플랫폼|27.*플랫폼|40.*도구|자기\s*개선|self.*improv/i.test(prompt)) return 'hermes';
    // 리서치/조사 → copilot
    if (/조사|리서치|research|찾아|알려/i.test(prompt)) return 'copilot';
    return null;
  }

  /**
   * Select optimal providers based on mode, availability, rate limits, and cost.
   */
  async selectProviders(mode: DiscussionMode, count?: number, prompt?: string): Promise<string[]> {
    const allProviders = agentManager.listEnabledIds();

    // Filter out rate-limited agents
    const available: string[] = [];
    for (const id of allProviders) {
      if (await this.isAvailable(id)) {
        available.push(id);
      }
    }

    if (available.length === 0) {
      log.warn('No available providers — falling back to all enabled');
      return allProviders.slice(0, count || 1);
    }

    // Determine count by mode
    const targetCount = count || this.getTargetCount(mode);

    // ── task 모드: 성능 DB → 키워드 순으로 최적 단일 프로바이더 선택 ──────
    if (mode === 'task' && targetCount === 1 && prompt) {
      // 1순위: 성능 DB 기반 (10회 이상 기록 있을 때만)
      const taskType = this.inferTaskType(prompt);
      const perfBest = this.bestPerformingProvider(taskType, available);
      if (perfBest) return [perfBest];
      // 2순위: 키워드 기반
      const preferred = this.preferredTaskProvider(prompt);
      if (preferred && available.includes(preferred)) {
        return [preferred];
      }
    }

    // ── nova-ax 모드: Nova-AX 전용 (폴백: codex) ──────────────────────
    if (mode === 'nova-ax') {
      const fallback = available.includes('codex') ? 'codex' : available[0];
      return [fallback];
    }

    // ── mesh 모드: inter-session broadcast 실행 (claude-code 우선) ──────
    if (mode === 'mesh') {
      const p = available.includes('claude-code') ? 'claude-code'
               : available.includes('codex') ? 'codex' : available[0];
      return [p];
    }

    // ── inter-session 모드: 특정 세션 DM (claude-code 우선) ─────────────
    if (mode === 'inter-session') {
      const p = available.includes('claude-code') ? 'claude-code'
               : available.includes('codex') ? 'codex' : available[0];
      return [p];
    }

    // ── full-pipeline/company 모드: 역할 기반 고정 순서 ──────────────
    if (mode === 'full-pipeline') {
      const preferred = ['opencode', 'codex', 'cursor-agent', 'nvidia', 'copilot'];
      return this.fillPreferredProviders(preferred, available, targetCount);
    }
    if (mode === 'company') {
      const preferred = ['opencode', 'agy', 'codex', 'cursor-agent'];
      return this.fillPreferredProviders(preferred, available, targetCount);
    }
    if (mode === 'team-project') {
      const preferred = this.getTeamProjectProviders().filter(p => available.includes(p));
      if (preferred.length > 0) {
        return preferred;
      }
      return available.slice(0, Math.min(targetCount, available.length));
    }

    if (this.shouldFrontloadMithosis(mode, prompt) && available.includes('mithosis')) {
      const preferred = ['mithosis', 'codex', 'opencode', 'cursor-agent', 'nvidia', 'openrouter'];
      return this.fillPreferredProviders(preferred, available, targetCount);
    }

    // 성공률 가중치 적용: 최근 실패율 높은 에이전트 후순위
    const scored = available.map(id => ({
      id,
      weight: getProviderSuccessWeight(id),
      costOrder: PROVIDER_COST_ORDER.indexOf(id),
    }));
    scored.sort((a, b) => {
      // 가중치 차이가 크면 우선 (0.3 이상 차이)
      const wDiff = b.weight - a.weight;
      if (Math.abs(wDiff) >= 0.3) return wDiff;
      // 가중치 비슷하면 cost order
      const ca = a.costOrder === -1 ? 999 : a.costOrder;
      const cb = b.costOrder === -1 ? 999 : b.costOrder;
      return ca - cb;
    });
    return scored.slice(0, targetCount).map(s => s.id);
  }

  private shouldFrontloadMithosis(mode: DiscussionMode, prompt?: string): boolean {
    if (prompt && /mithosis|미쏘스|미토시스|meta.?orchestr|오케스트레이션|self.?reinforcement|dynamic.?skills/i.test(prompt)) {
      return true;
    }
    return ['parallel', 'discussion', 'consensus', 'commander', 'hive', 'company', 'full-pipeline'].includes(mode);
  }

  private fillPreferredProviders(preferred: string[], available: string[], targetCount: number): string[] {
    const selected = preferred.filter(p => available.includes(p));
    if (selected.length >= targetCount) {
      return selected.slice(0, targetCount);
    }

    const fallbacks = sortProvidersByCostOrder(available).filter(p => !selected.includes(p));
    return [...selected, ...fallbacks].slice(0, targetCount);
  }

  /**
   * 프롬프트에서 TaskType을 추론한다 (QualityGate/성능 DB 연동).
   */
  inferTaskType(prompt: string): TaskType {
    if (/구현|수정|버그|코드|fix|implement|build|작성|추가|개발/i.test(prompt)) return 'code';
    if (/설계|아키텍처|design|architecture|구조/i.test(prompt)) return 'design';
    if (/리뷰|review|보안|검토|security/i.test(prompt)) return 'review';
    if (/검증|verify|test|테스트/i.test(prompt)) return 'verify';
    if (/조사|리서치|research|찾아|알려/i.test(prompt)) return 'research';
    if (/UI|UX|프론트엔드|대시보드|화면|interface/i.test(prompt)) return 'ui';
    if (/이미지|영상|비디오|image|video/i.test(prompt)) return 'media';
    return 'general';
  }

  /**
   * 성능 DB에서 해당 task_type에 가장 높은 avg_quality를 가진 에이전트 반환.
   * 신뢰도 부족(runs < 10)이면 null 반환 → 키워드 폴백.
   */
  private bestPerformingProvider(taskType: TaskType, available: string[]): string | null {
    try {
      const db = getDb();
      const rows = db.prepare(
        `SELECT agent_id, avg_quality, total_runs FROM agent_performance_summary
         WHERE task_type=? AND total_runs >= 10
         ORDER BY avg_quality DESC LIMIT 5`
      ).all(taskType) as any[];
      for (const row of rows) {
        if (available.includes(row.agent_id)) {
          log.debug({ agentId: row.agent_id, avgQuality: row.avg_quality, taskType }, 'Performance-based routing');
          return row.agent_id;
        }
      }
    } catch { /* DB not ready */ }
    return null;
  }

  /**
   * Full auto-dispatch: analyze → select mode → select providers.
   */
  async dispatch(prompt: string): Promise<RouteDecision> {
    const complexity = this.analyzeComplexity(prompt);
    const mode = this.selectMode(prompt, complexity);
    const providers = await this.selectProviders(mode, undefined, prompt);

    // mesh/inter-session 모드: 타겟·메시지 메타 추출
    let meta: Record<string, string> | undefined;
    if (mode === 'inter-session' || mode === 'mesh') {
      meta = extractInterSessionMeta(prompt);
    }

    const reasoning = `Complexity ${complexity}/10 → mode: ${mode}, ${providers.length} provider(s): [${providers.join(', ')}]${meta?.target ? ` → target: ${meta.target}` : ''}`;
    log.info({ complexity, mode, providers, meta }, reasoning);

    return { mode, providers, complexity, reasoning, meta };
  }

  /**
   * Get provider availability (not rate-limited, circuit not open).
   */
  private async isAvailable(agentId: string): Promise<boolean> {
    // Check rate limit state in DB
    try {
      const db = getDb();
      const state = db.prepare(
        'SELECT is_limited FROM rate_limit_state WHERE agent_id = ?'
      ).get(agentId) as any;

      if (state?.is_limited) return false;
    } catch { /* ignore */ }

    // Check circuit breaker via shared state
    try {
      const agentState = await sharedState.getAgentState(agentId);
      if (agentState?.health?.circuitState === 'open') return false;
    } catch { /* ignore */ }

    return true;
  }

  private getTargetCount(mode: DiscussionMode): number {
    switch (mode) {
      case 'task': return 1;
      case 'parallel': return 3;
      case 'discussion': return 3;
      case 'consensus': return 4;
      case 'hive': return 9;
      case 'broadcast': return 9;
      case 'commander': return 5;
      // ── 신규 모드 ──────────────────────────────────
      case 'nova-ax': return 1;          // Nova-AX 전용 단일 호출
      case 'company': return 4;          // 기획/설계/구현/QA 4역할
      case 'team-project': return 3;     // 팀장+구현자+리뷰어
      case 'full-pipeline': return 5;    // 전체 파이프라인 5개 에이전트
      case 'mesh': return 1;             // mesh 브로드캐스트 (단일 제어)
      case 'inter-session': return 1;    // 특정 세션 직접 메시지
      default: return 1;
    }
  }

  /**
   * Return role-based provider list for full-pipeline & company modes.
   * Stages: plan → discuss → design → implement → review → gap → verify
   */
  getPipelineProviders(): string[] {
    return ['opencode', 'codex', 'cursor-agent', 'nvidia', 'copilot'];
  }

  getCompanyProviders(): string[] {
    return ['opencode', 'agy', 'codex', 'cursor-agent'];
  }

  getTeamProjectProviders(): string[] {
    return ['opencode', 'codex', 'cursor-agent'];
  }

  /**
   * Get role-based providers for Commander mode.
   */
  getRoleProviders(layer: keyof typeof ROLE_MAP): string[] {
    return ROLE_MAP[layer] || [];
  }
}

export const smartRouter = new SmartRouter();

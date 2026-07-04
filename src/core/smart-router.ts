import { agentManager } from '../agent/agent-manager.js';
import { sharedState } from './shared-state.js';
import { getDb } from '../storage/database.js';
import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';
import { createLogger } from '../utils/logger.js';
import type { TaskType } from './quality-gate.js';
import { classifyTier, orderByTier, LAYER_TIER_AGENTS, type Tier } from './tier-policy.js';

const log = createLogger('smart-router');

type DiscussionMode = 'task' | 'parallel' | 'discussion' | 'consensus' | 'hive' | 'broadcast' | 'commander';

interface RouteDecision {
  mode: DiscussionMode;
  providers: string[];
  complexity: number;
  reasoning: string;
  tier: Tier; // 두뇌(brain=유료 스마트) / 워커(worker=무료 로컬)
}

export class ProviderSelectionError extends Error {
  constructor(
    message: string,
    readonly mode: DiscussionMode,
    readonly requiredMinimum: number,
    readonly eligibleProviders: string[],
    readonly availableProviders: string[],
  ) {
    super(message);
    this.name = 'ProviderSelectionError';
  }
}

// Keyword → mode trigger map
const KEYWORD_TRIGGERS: Array<{ pattern: RegExp; mode: DiscussionMode; minAI: number }> = [
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
];

// Role → preferred agents map (tier-policy.ts 단일 소스 참조).
// Brain(유료)=management/quality, Worker(무료 로컬)=execution.
const ROLE_MAP = {
  management: LAYER_TIER_AGENTS.management,
  information: LAYER_TIER_AGENTS.information,
  execution: LAYER_TIER_AGENTS.execution,
  quality: LAYER_TIER_AGENTS.quality,
};

/** Prefer local MLX first, then vLLM, then other free tiers. */
export const PROVIDER_COST_ORDER = [
  'mlx', 'vllm', 'openrouter', 'aider', 'copilot', 'codex', 'cursor-agent', 'opencode', 'claude-code',
];

export function sortProvidersByCostOrder(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const ia = PROVIDER_COST_ORDER.indexOf(a);
    const ib = PROVIDER_COST_ORDER.indexOf(b);
    const sa = ia === -1 ? 999 : ia;
    const sb = ib === -1 ? 999 : ib;
    return sa - sb;
  });
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
    if (complexity <= 3) return 'task';
    if (complexity <= 5) return 'task';
    if (complexity <= 6) return 'parallel';
    if (complexity <= 8) return 'discussion';
    if (complexity <= 9) return 'consensus';
    return 'hive';
  }

  /**
   * Select optimal providers based on mode, availability, rate limits, and cost.
   */
  async selectProviders(mode: DiscussionMode, count?: number, tier?: Tier): Promise<string[]> {
    const allProviders = agentManager.listEnabledIds();

    // Filter out rate-limited agents
    const available: string[] = [];
    for (const id of allProviders) {
      if (await this.isAvailable(id)) {
        available.push(id);
      }
    }

    const targetCount = count || this.getTargetCount(mode);
    // tier 지정 시 두뇌/워커 우선순위로 정렬, 없으면 기존 비용순.
    // 두뇌 태스크 → 유료 스마트 우선, 워커 태스크 → 무료 로컬 우선 (반대 tier는 fallback).
    const sorted = tier ? orderByTier(available, tier) : sortProvidersByCostOrder(available);
    const selected = sorted.slice(0, targetCount);
    const requiredMinimum = this.getMinimumCount(mode);

    if (selected.length < requiredMinimum) {
      throw new ProviderSelectionError(
        `insufficient available providers for ${mode}`,
        mode,
        requiredMinimum,
        selected,
        sorted,
      );
    }

    return selected;
  }

  /**
   * Full auto-dispatch: analyze → select mode → select providers.
   */
  async dispatch(prompt: string): Promise<RouteDecision> {
    const complexity = this.analyzeComplexity(prompt);
    const mode = this.selectMode(prompt, complexity);
    const tier = classifyTier(prompt, complexity);
    const providers = await this.selectProviders(mode, undefined, tier);

    const reasoning = `Complexity ${complexity}/10 → mode: ${mode}, tier: ${tier}(${tier === 'brain' ? '유료 두뇌' : '무료 워커'}), ${providers.length} provider(s): [${providers.join(', ')}]`;
    log.info({ complexity, mode, tier, providers }, reasoning);

    return { mode, providers, complexity, reasoning, tier };
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
    const snapshot = circuitBreakerRegistry.getSnapshot(agentId);
    if (snapshot.state === 'open') return false;

    // gate 가용성: circuit-open 외에 quota/rate-limit/auth 소진(gated:*)도 사전 제외.
    // 저사양 머신에서 credit 소진된 무료 워커(예: hermes)를 첫 시도로 고르지 않고
    // 다음 가용 무료 워커(nvidia/openrouter)로 즉시 폴백 (2026-07-04, subnote T1).
    try {
      if (!circuitBreakerRegistry.getAvailability(agentId).available) return false;
    } catch { /* ignore */ }

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
      default: return 1;
    }
  }

  private getMinimumCount(mode: DiscussionMode): number {
    switch (mode) {
      case 'parallel': return 2;
      case 'discussion': return 3;
      case 'consensus': return 3;
      case 'hive': return 2;
      default: return 1;
    }
  }

  /**
   * Infer a TaskType from a prompt for quality gate evaluation.
   */
  inferTaskType(prompt: string): TaskType {
    if (/test|spec|검증|verify/i.test(prompt)) return 'verify';
    if (/review|audit|검토/i.test(prompt)) return 'review';
    if (/design|architect|구조|설계/i.test(prompt)) return 'design';
    if (/research|찾아|조사/i.test(prompt)) return 'research';
    if (/ui|frontend|화면|스타일/i.test(prompt)) return 'ui';
    if (/image|video|영상|이미지/i.test(prompt)) return 'media';
    if (/code|fix|bug|implement|add|create|refactor|수정|구현/i.test(prompt)) return 'code';
    return 'general';
  }

  /**
   * Get role-based providers for Commander mode.
   */
  getRoleProviders(layer: keyof typeof ROLE_MAP): string[] {
    return ROLE_MAP[layer] || [];
  }
}

export const smartRouter = new SmartRouter();

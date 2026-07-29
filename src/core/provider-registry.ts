/**
 * Provider Registry — 프로바이더 목록의 단일 진실 공급원(SSOT).
 *
 * 배경: 2026-07-29 nvidia 퇴출 작업에서 프로바이더 id 가 src 41개 파일에
 * 하드코딩돼 있고, 그중 일부(copilot, aider)는 config/ai-providers.json 에서
 * 이미 사라졌는데도 라우팅 테이블에 남아 있는 드리프트가 드러났다.
 * 프로바이더 하나를 빼려면 코드 수십 곳을 손으로 고쳐야 했다.
 *
 * 아래 resolvePreference 계층의 계약:
 *   1. 등록 여부의 기준은 오직 config/ai-providers.json(+ .local 오버레이).
 *   2. 코드의 선호 순서표는 "큐레이션된 힌트"일 뿐이고, 등록되지 않은 id 는
 *      런타임에 걸러진다        → 삭제 = config 에서 지우면 끝.
 *   3. 순서표에 없어도 등록돼 있고 역량이 맞으면 뒤에 자동 편입된다
 *                              → 추가 = config 에 넣으면 끝.
 *
 * 이 계층을 우회하는 새 하드코딩은 tests/provider-drift.test.ts 가 잡는다.
 */
import { loadEnabledProviders, loadProviders, type ProviderConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('provider-registry');

export class ProviderRegistry {
  private providers = new Map<string, ProviderConfig>();

  async init(): Promise<void> {
    const providers = loadEnabledProviders();
    for (const p of providers) {
      this.providers.set(p.id, p);
    }
    log.info({ count: providers.length }, 'Provider Registry initialized');
  }

  get(id: string): ProviderConfig | undefined {
    return this.providers.get(id);
  }

  list(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  listEnabledIds(): string[] {
    return Array.from(this.providers.keys());
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }
}

export const providerRegistry = new ProviderRegistry();

// ── 라우팅 해석 계층 ──────────────────────────────────────────────────────
// 위 클래스는 부팅 시 init() 된 "활성" 프로바이더를 다루고, 아래 함수들은
// init 없이도 쓸 수 있도록 config 를 직접 읽는다(라우팅 테이블은 모듈 로드
// 시점에 평가되는 곳이 많아 부팅 순서에 의존하면 안 된다).

/** 라우팅에 쓰이는 작업 유형. company-orchestrator 의 TaskType 과 같은 축. */
export type ProviderTaskType =
  | 'design' | 'code' | 'review' | 'verify' | 'research' | 'ui' | 'media' | 'general';

/**
 * 작업 유형 → 그 유형에 유효한 capability 토큰.
 * config 의 capabilities 와 대조해 신규 프로바이더의 자동 편입 순위를 만든다.
 * id 가 아니라 capability 로 매칭하므로 프로바이더가 늘어도 이 표는 그대로다.
 */
const TASK_CAPABILITIES: Record<ProviderTaskType, string[]> = {
  design:   ['design', 'architecture', 'patterns', 'multi-model'],
  code:     ['code', 'code-generation', 'generation', 'algorithms'],
  review:   ['review', 'code-review', 'bug-detection', 'security'],
  verify:   ['verification', 'validation', 'testing'],
  research: ['reasoning', 'analysis', 'tool-use', 'function-calling'],
  ui:       ['ui-ux', 'visual', 'patterns'],
  media:    ['media', 'image-generation', 'video-generation', 'visual-ai'],
  general:  ['code', 'analysis', 'reasoning', 'writing', 'reporting'],
};

let registryCache: ProviderConfig[] | null = null;

/** 등록된 프로바이더 전체(비활성 포함). config 변경 뒤에는 reloadRegistry(). */
export function registeredProviders(): ProviderConfig[] {
  if (registryCache === null) registryCache = loadProviders();
  return registryCache;
}

/** config 를 다시 읽게 한다. 테스트·핫리로드 경로에서 사용. */
export function reloadRegistry(): void {
  registryCache = null;
}

/** 테스트 전용 주입. null 을 주면 파일 기반으로 되돌아간다. */
export function __setRegistryForTest(providers: ProviderConfig[] | null): void {
  registryCache = providers;
}

/** 등록된 프로바이더 id 집합. */
export function registeredProviderIds(): Set<string> {
  return new Set(registeredProviders().map((provider) => provider.id));
}

/** id 가 현재 config 에 등록돼 있는가. */
export function isRegistered(id: string): boolean {
  return registeredProviderIds().has(id);
}

/**
 * 등록되지 않은 id 를 제거한다(순서 유지, 중복 제거).
 * 퇴출된 프로바이더가 순서표에 남아 있어도 라우팅에 도달하지 않게 하는 안전망.
 */
export function filterRegistered(ids: readonly string[]): string[] {
  const known = registeredProviderIds();
  const seen = new Set<string>();
  return ids.filter((id) => {
    if (!known.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * 작업 유형에 대한 capability 기반 순위.
 * 가중치 = 매칭 capability 수 * 1000 + provider.score → 역량 우선, 동률은 score.
 * 매칭이 0 이면 그 유형의 후보가 아니므로 제외한다.
 */
export function capabilityRank(taskType: ProviderTaskType): string[] {
  const wanted = TASK_CAPABILITIES[taskType] ?? TASK_CAPABILITIES.general;
  return registeredProviders()
    .map((provider) => {
      // capabilities/score 는 스키마상 필수지만, 부분 정의된 fake provider 로
      // 라우팅을 테스트하는 경로가 있어 방어적으로 읽는다. 역량 선언이 없으면
      // 자동 편입 대상이 아닐 뿐이며 큐레이션 순서에는 영향이 없다.
      const declared = provider.capabilities ?? [];
      const hits = declared.filter((capability) => wanted.includes(capability)).length;
      return { id: provider.id, weight: hits * 1000 + (provider.score ?? 0), hits };
    })
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.weight - a.weight)
    .map((entry) => entry.id);
}

/**
 * 선언된 선호 순서를 레지스트리와 화해시킨다.
 *
 *   [큐레이션 순서 중 등록된 것] ++ [순서표에 없지만 역량이 맞는 등록 프로바이더]
 *
 * 앞부분이 기존 동작을 보존하고, 뒷부분이 신규 프로바이더 자동 편입을 만든다.
 * taskType 을 생략하면 필터링만 한다(순서 자체가 정책인 경우).
 */
export function resolvePreference(
  declared: readonly string[],
  taskType?: ProviderTaskType,
): string[] {
  const curated = filterRegistered(declared);
  if (!taskType) return curated;
  const curatedSet = new Set(curated);
  return [...curated, ...capabilityRank(taskType).filter((id) => !curatedSet.has(id))];
}

/**
 * 계층 판별 폴백. 명시 순서표(tier-policy)에 없는 신규 프로바이더를
 * config 의 cost/type 으로 분류한다: local 또는 free → worker, paid → brain.
 */
export function derivedTier(id: string): 'brain' | 'worker' | 'unknown' {
  const provider = registeredProviders().find((entry) => entry.id === id);
  if (!provider) return 'unknown';
  if (provider.type === 'local') return 'worker';
  return provider.cost === 'paid' ? 'brain' : 'worker';
}

/** 특정 capability 를 선언한 등록 프로바이더(점수 내림차순). */
export function providersWithCapability(capability: string): string[] {
  return registeredProviders()
    .filter((provider) => provider.capabilities.includes(capability))
    .sort((a, b) => b.score - a.score)
    .map((provider) => provider.id);
}
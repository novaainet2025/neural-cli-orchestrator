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
import {
  providersForDepartment,
  providersForTaskType,
  PROVIDER_TASK_CAPABILITIES,
  resolveProviderRouting,
  type ProviderDepartment,
} from './provider-catalog.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('provider-registry');

export class ProviderRegistry {
  private providers = new Map<string, ProviderConfig>();

  async init(): Promise<void> {
    const providers = loadEnabledProviders();
    this.replace(providers);
    log.info({ count: providers.length }, 'Provider Registry initialized');
  }

  replace(providers: readonly ProviderConfig[]): void {
    this.providers = new Map(
      providers.filter(provider => provider.enabled !== false).map(provider => [provider.id, provider]),
    );
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

/** Commit the same validated snapshot used by runtime admission and assignment. */
export function commitRegistryView(providers: readonly ProviderConfig[]): void {
  registryCache = [...providers];
  providerRegistry.replace(providers);
}

/** 테스트 전용 주입. null 을 주면 파일 기반으로 되돌아간다. */
export function __setRegistryForTest(providers: ProviderConfig[] | null): void {
  registryCache = providers;
}

/** 등록된 프로바이더 id 집합. */
export function registeredProviderIds(): Set<string> {
  return new Set(registeredProviders().map((provider) => provider.id));
}

/** 현재 머신에서 enabled=true인 실제 라우팅 후보 id 집합. */
export function routableProviderIds(): Set<string> {
  return new Set(registeredProviders().filter(provider => provider.enabled).map(provider => provider.id));
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

/** 등록돼 있어도 disabled인 프로바이더는 실행 후보에서 제거한다. */
export function filterRoutable(ids: readonly string[]): string[] {
  const known = routableProviderIds();
  const seen = new Set<string>();
  return ids.filter(id => {
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
  const wanted = PROVIDER_TASK_CAPABILITIES[taskType] ?? PROVIDER_TASK_CAPABILITIES.general;
  const catalogOrder = providersForTaskType(registeredProviders(), taskType)
    .map(provider => provider.id);
  const catalogRank = new Map(catalogOrder.map((id, index) => [id, index]));
  return registeredProviders()
    .filter(provider => provider.enabled)
    .map((provider) => {
      // capabilities/score 는 스키마상 필수지만, 부분 정의된 fake provider 로
      // 라우팅을 테스트하는 경로가 있어 방어적으로 읽는다. 역량 선언이 없으면
      // 자동 편입 대상이 아닐 뿐이며 큐레이션 순서에는 영향이 없다.
      const declared = provider.capabilities ?? [];
      const hits = declared.filter((capability) => wanted.includes(capability)).length;
      return { id: provider.id, weight: hits * 1000 + (provider.score ?? 0), hits };
    })
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => {
      const byWeight = b.weight - a.weight;
      if (byWeight !== 0) return byWeight;
      return (catalogRank.get(a.id) ?? Number.MAX_SAFE_INTEGER)
        - (catalogRank.get(b.id) ?? Number.MAX_SAFE_INTEGER);
    })
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
  const curated = filterRoutable(declared);
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
  return resolveProviderRouting(provider).tier;
}

/** 특정 capability 를 선언한 등록 프로바이더(점수 내림차순). */
export function providersWithCapability(capability: string): string[] {
  return registeredProviders()
    .filter((provider) => provider.enabled && provider.capabilities.includes(capability))
    .sort((a, b) => b.score - a.score)
    .map((provider) => provider.id);
}

/** Commander/department rosters are catalog-derived and never name providers. */
export function departmentRank(department: ProviderDepartment): string[] {
  return providersForDepartment(registeredProviders(), department).map(provider => provider.id);
}

/** Brain/worker rosters are inferred from catalog routing metadata. */
export function tierRank(tier: 'brain' | 'worker'): string[] {
  return registeredProviders()
    .filter(provider => provider.enabled && resolveProviderRouting(provider).tier === tier)
    .sort((left, right) => {
      const byPriority = resolveProviderRouting(right).priority
        - resolveProviderRouting(left).priority;
      return byPriority || right.score - left.score || left.id.localeCompare(right.id);
    })
    .map(provider => provider.id);
}

// ── 실행 경계 provider 해석 ──────────────────────────────────────────────

export type ProviderResolutionErrorCode =
  | 'provider_not_registered'
  | 'provider_disabled'
  | 'provider_unavailable';

/**
 * 실행 직전 provider 해석 실패. 호출자는 이 코드를 HTTP/작업 상태에 그대로
 * 보존해야 하며, 명시적으로 요청된 provider를 다른 provider로 대체하면 안 된다.
 */
export class ProviderResolutionError extends Error {
  readonly statusCode: 400 | 409;

  constructor(
    readonly code: ProviderResolutionErrorCode,
    readonly providerId: string | null,
    readonly taskType: ProviderTaskType,
  ) {
    const detail = providerId ? `: ${providerId}` : '';
    super(`${code}${detail}`);
    this.name = 'ProviderResolutionError';
    this.statusCode = code === 'provider_not_registered' ? 400 : 409;
  }

  toResponse(): {
    error: ProviderResolutionErrorCode;
    providerId: string | null;
    taskType: ProviderTaskType;
  } {
    return { error: this.code, providerId: this.providerId, taskType: this.taskType };
  }
}

/**
 * 실행 provider를 config SSOT에서 해석한다.
 *
 * - 명시 id: 등록+enabled 여부만 검증하고 그대로 반환한다(무음 대체 금지).
 * - 생략: 작업 capability 순위, 그 다음 enabled catalog score 순으로 선택한다.
 */
export function resolveExecutionProvider(
  requestedProvider?: string | null,
  taskType: ProviderTaskType = 'general',
): string {
  const requested = requestedProvider?.trim();
  if (requested) {
    const provider = registeredProviders().find(entry => entry.id === requested);
    if (!provider) {
      throw new ProviderResolutionError('provider_not_registered', requested, taskType);
    }
    if (!provider.enabled) {
      throw new ProviderResolutionError('provider_disabled', requested, taskType);
    }
    return provider.id;
  }

  const ranked = capabilityRank(taskType);
  const selected = ranked[0] ?? registeredProviders()
    .filter(provider => provider.enabled)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))[0]?.id;
  if (!selected) {
    throw new ProviderResolutionError('provider_unavailable', null, taskType);
  }
  return selected;
}

/** Explicit participant lists keep intent but can never carry a stale id to I/O. */
export function reconcileExecutionProviders(
  requestedProviders: readonly string[],
  taskType: ProviderTaskType = 'general',
): string[] {
  const unique = [...new Set(requestedProviders.map(provider => provider.trim()).filter(Boolean))];
  return unique.map(provider => resolveExecutionProvider(provider, taskType));
}

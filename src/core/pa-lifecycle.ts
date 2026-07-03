/**
 * pa-lifecycle.ts — PA(Persistent Agent) 수명주기 비용 노브 (optio port, P2-10).
 *
 * 배경(이식 후보 P2-10): "always-on / sticky(웜 유지) / on-demand — NCO CLI
 * lazy-spawn에 sticky 모드를 추가하면 반복 위임 시 cold-start를 절감한다."
 *
 * 이 모듈은 에이전트별 수명주기 모드의 **단일 소스**이자, 웜 상태 추적 +
 * 축출(eviction) 결정 로직이다. 실제 spawn/kill은 호출자(agent-manager)가
 * 이 정책의 결정을 받아 수행한다.
 *
 * 설계 원칙:
 *  - 순수/결정론적: Date.now()/Math.random() 미사용. 시각은 now 인자로 주입.
 *  - I/O 없음(인메모리 레지스트리). 단위 테스트 가능.
 */

/** 수명주기 모드. */
export type LifecycleMode = 'always-on' | 'sticky' | 'on-demand';

/** 에이전트별 기본 모드 정책. tier-policy와 유사하게 여기서 단일 관리. */
export interface LifecyclePolicyOptions {
  /** 명시 매핑(agentId → 모드). 없으면 defaultMode. */
  readonly modes?: Readonly<Record<string, LifecycleMode>>;
  /** 매핑에 없는 에이전트의 기본 모드. 기본 'sticky'. */
  readonly defaultMode?: LifecycleMode;
  /** sticky 모드 웜 유지 시간(ms). 기본 5분. */
  readonly stickyTtlMs?: number;
}

/** 웜 상태 1건. */
export interface WarmEntry {
  readonly agentId: string;
  /** 마지막 사용 시각(epoch ms, 주입된 now 기준). */
  lastUsedAt: number;
  readonly mode: LifecycleMode;
}

export const DEFAULT_STICKY_TTL_MS = 5 * 60_000;

/**
 * PA 수명주기 정책 + 웜 레지스트리.
 * - markUsed: 에이전트 사용 시각 갱신(sticky/always-on 웜 유지 대상 등록).
 * - shouldKeepWarm: 지금 이 에이전트를 살려둘지(cold-start 회피) 결정.
 * - evictable: 축출 대상(모드·TTL 기준으로 내려도 되는) 목록.
 */
export class PaLifecycle {
  readonly defaultMode: LifecycleMode;
  readonly stickyTtlMs: number;
  private readonly modes: Record<string, LifecycleMode>;
  private readonly warm = new Map<string, WarmEntry>();

  constructor(options: LifecyclePolicyOptions = {}) {
    this.defaultMode = options.defaultMode ?? 'sticky';
    this.stickyTtlMs = options.stickyTtlMs ?? DEFAULT_STICKY_TTL_MS;
    if (!Number.isFinite(this.stickyTtlMs) || this.stickyTtlMs < 0) {
      throw new Error(`PaLifecycle: stickyTtlMs must be >= 0, got ${this.stickyTtlMs}`);
    }
    this.modes = { ...(options.modes ?? {}) };
  }

  /** 에이전트의 수명주기 모드. */
  modeOf(agentId: string): LifecycleMode {
    return this.modes[agentId] ?? this.defaultMode;
  }

  /** 런타임에 모드 오버라이드. */
  setMode(agentId: string, mode: LifecycleMode): void {
    this.modes[agentId] = mode;
  }

  /**
   * 에이전트 사용을 기록한다(위임 완료/시작 시 호출). on-demand는 웜 유지 대상이
   * 아니므로 레지스트리에 남기지 않는다.
   */
  markUsed(agentId: string, now: number): void {
    const mode = this.modeOf(agentId);
    if (mode === 'on-demand') {
      this.warm.delete(agentId);
      return;
    }
    this.warm.set(agentId, { agentId, lastUsedAt: now, mode });
  }

  /**
   * 지금 이 에이전트를 웜 상태로 유지할지 결정한다.
   *  - always-on: 항상 true.
   *  - sticky: 마지막 사용 후 stickyTtlMs 이내면 true.
   *  - on-demand: 항상 false(사용 후 즉시 내려도 됨).
   */
  shouldKeepWarm(agentId: string, now: number): boolean {
    const mode = this.modeOf(agentId);
    if (mode === 'always-on') return true;
    if (mode === 'on-demand') return false;
    const entry = this.warm.get(agentId);
    if (!entry) return false;
    return now - entry.lastUsedAt <= this.stickyTtlMs;
  }

  /** 웜 유지 TTL이 지나 축출 가능한 에이전트 목록. always-on은 절대 포함 안 됨. */
  evictable(now: number): string[] {
    const out: string[] = [];
    for (const [agentId, entry] of this.warm) {
      if (entry.mode === 'always-on') continue;
      if (now - entry.lastUsedAt > this.stickyTtlMs) out.push(agentId);
    }
    return out.sort();
  }

  /** 축출을 확정(레지스트리에서 제거). 호출자가 실제 kill 후 부른다. */
  evict(agentId: string): void {
    this.warm.delete(agentId);
  }

  /** 현재 웜 상태 스냅샷(모니터/디버그용). */
  snapshot(): WarmEntry[] {
    return [...this.warm.values()]
      .map((e) => ({ ...e }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
  }
}

/** 팩토리. */
export function createPaLifecycle(options: LifecyclePolicyOptions = {}): PaLifecycle {
  return new PaLifecycle(options);
}

import { createHash } from 'node:crypto';
import { circuitBreakerRegistry, type CircuitState } from './circuit-breaker-registry.js';

export interface CircuitBreakerConfig {
  failureThreshold: number;    // consecutive failures to open (default 3)
  resetTimeoutMs: number;      // time before half-open (default 60000)
  halfOpenMaxAttempts: number;  // attempts in half-open (default 1)
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
  halfOpenMaxAttempts: 1,
};

export class CircuitBreaker {
  private agentId: string;
  private config: CircuitBreakerConfig;

  constructor(agentId: string, config?: Partial<CircuitBreakerConfig>) {
    this.agentId = agentId;
    this.config = {
      failureThreshold: normalizePositiveInteger(config?.failureThreshold, DEFAULT_CONFIG.failureThreshold),
      resetTimeoutMs: normalizePositiveInteger(config?.resetTimeoutMs, DEFAULT_CONFIG.resetTimeoutMs),
      halfOpenMaxAttempts: normalizePositiveInteger(config?.halfOpenMaxAttempts, DEFAULT_CONFIG.halfOpenMaxAttempts),
    };
  }

  canExecute(): boolean {
    return circuitBreakerRegistry.canExecute(this.agentId, this.config);
  }

  recordSuccess(): void {
    circuitBreakerRegistry.recordSuccess(this.agentId);
  }

  recordFailure(error?: string): void {
    circuitBreakerRegistry.recordFailure(this.agentId, error, this.config);
  }

  getState(): CircuitState { return circuitBreakerRegistry.getSnapshot(this.agentId).state; }
  getFailures(): number { return circuitBreakerRegistry.getSnapshot(this.agentId).failureCount; }

  reset(): void {
    circuitBreakerRegistry.reset(this.agentId);
  }

  /**
   * collaboration-msg-loop 룰을 이 에이전트가 보내는 협업 메시지에 적용한다.
   * 채널 키는 `<agentId>-><peerSessionId>` 이며, 프로바이더 회로 상태와는 독립이다
   * (협업 메시지 루프는 프로바이더 장애가 아니므로 circuit_states를 오염시키지 않는다).
   */
  checkCollaborationMessage(
    peerSessionId: string,
    content: string,
    config?: Partial<CollaborationLoopRuleConfig>,
  ): CollaborationLoopDecision {
    return collaborationLoopGuard.check(
      collaborationChannelKey(this.agentId, peerSessionId),
      content,
      config,
    );
  }

  toJSON() {
    const snapshot = circuitBreakerRegistry.getSnapshot(this.agentId);
    return {
      state: snapshot.state,
      failures: snapshot.failureCount,
      lastFailureAt: snapshot.openedAt ?? 0,
      cooldownUntil: snapshot.cooldownUntil,
      reason: snapshot.reason,
      agentId: this.agentId,
    };
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

// ─── collaboration-msg-loop 방지 룰 ────────────────────────────────────────
//
// 근거(48h 실측, db/nco.db mesh_messages):
//   - 동일 (from,to) 채널에서 완전히 같은 본문이 60초 이내에 최대 72회 재전송됨
//   - 동일 채널 분당 메시지 최대 41건 (정상 협업 채널은 48h 총 64건 ≈ 1.3건/시간)
// 협업 엔진이 초대/기여 메시지를 재전송하거나 A→B→A 에코가 발생하면 mesh 큐가
// 같은 내용으로 포화되어 실제 단계 산출물이 묻힌다. 프로바이더 회로와 달리 이는
// 채널 단위 현상이므로 별도 인메모리 가드로 처리한다(DB 쓰기 없음 = 되돌리기 쉬움).

/** 룰이 차단 사유로 보고하는 두 가지 루프 형태. */
export type CollaborationLoopRule = 'echo-loop' | 'channel-burst';

export interface CollaborationLoopRuleConfig {
  /** 슬라이딩 윈도 길이 (ms). */
  windowMs: number;
  /** 윈도 안에서 허용하는 동일 본문 재전송 횟수. 초과분이 echo-loop으로 차단된다. */
  maxRepeatsPerWindow: number;
  /** 윈도 안에서 허용하는 채널 전체 메시지 수. 초과분이 channel-burst로 차단된다. */
  maxMessagesPerWindow: number;
  /** 룰이 트립된 뒤 해당 채널을 차단해 두는 시간 (ms). */
  cooldownMs: number;
  /** 추적 채널 수 상한 — 초과 시 가장 오래 쓰이지 않은 채널부터 제거(메모리 누수 방지). */
  maxTrackedChannels: number;
}

export const DEFAULT_COLLABORATION_LOOP_CONFIG: CollaborationLoopRuleConfig = {
  windowMs: 60_000,
  maxRepeatsPerWindow: 3,
  maxMessagesPerWindow: 20,
  cooldownMs: 60_000,
  maxTrackedChannels: 500,
};

export interface CollaborationLoopDecision {
  /** false이면 호출자는 해당 메시지를 전송하지 말아야 한다. */
  allowed: boolean;
  /** 차단된 경우 어떤 룰이 트립했는지. 통과 시 null. */
  rule: CollaborationLoopRule | null;
  reason: string | null;
  channel: string;
  /** 현재 윈도에서 관측된 동일 본문 횟수(이번 메시지 포함). */
  repeats: number;
  /** 현재 윈도에서 관측된 채널 전체 메시지 수(이번 메시지 포함). */
  windowCount: number;
  /** 차단 중일 때 해제 예정 시각(epoch ms). 통과 시 null. */
  cooldownUntil: number | null;
}

interface ChannelWindow {
  timestamps: number[];
  /** 본문 서명 → 윈도 내 전송 시각들. */
  signatures: Map<string, number[]>;
  cooldownUntil: number | null;
  trippedRule: CollaborationLoopRule | null;
  lastSeenAt: number;
}

export function collaborationChannelKey(fromSessionId: string, toSessionId: string): string {
  return `${fromSessionId}->${toSessionId}`;
}

/**
 * 공백만 다른 재전송을 같은 메시지로 보기 위해 정규화 후 해싱한다.
 * 본문 전체를 보관하지 않으므로 채널당 메모리는 상수에 가깝다.
 */
function contentSignature(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return createHash('sha1').update(normalized).digest('hex');
}

function pruneWindow(entry: ChannelWindow, cutoff: number): void {
  entry.timestamps = entry.timestamps.filter(at => at > cutoff);
  for (const [signature, times] of entry.signatures) {
    const kept = times.filter(at => at > cutoff);
    if (kept.length === 0) entry.signatures.delete(signature);
    else entry.signatures.set(signature, kept);
  }
}

export class CollaborationLoopGuard {
  private channels = new Map<string, ChannelWindow>();

  /**
   * 메시지 전송 직전에 호출한다. 차단된 메시지는 윈도에 기록하지 않으므로,
   * 루프가 계속 재시도하더라도 쿨다운이 무한히 연장되지 않고 반드시 만료된다.
   */
  check(
    channel: string,
    content: string,
    config?: Partial<CollaborationLoopRuleConfig>,
  ): CollaborationLoopDecision {
    const resolved: CollaborationLoopRuleConfig = {
      windowMs: normalizePositiveInteger(config?.windowMs, DEFAULT_COLLABORATION_LOOP_CONFIG.windowMs),
      maxRepeatsPerWindow: normalizePositiveInteger(config?.maxRepeatsPerWindow, DEFAULT_COLLABORATION_LOOP_CONFIG.maxRepeatsPerWindow),
      maxMessagesPerWindow: normalizePositiveInteger(config?.maxMessagesPerWindow, DEFAULT_COLLABORATION_LOOP_CONFIG.maxMessagesPerWindow),
      cooldownMs: normalizePositiveInteger(config?.cooldownMs, DEFAULT_COLLABORATION_LOOP_CONFIG.cooldownMs),
      maxTrackedChannels: normalizePositiveInteger(config?.maxTrackedChannels, DEFAULT_COLLABORATION_LOOP_CONFIG.maxTrackedChannels),
    };

    const now = Date.now();
    const entry = this.ensure(channel, now, resolved.maxTrackedChannels);
    entry.lastSeenAt = now;

    if (entry.cooldownUntil != null) {
      if (now < entry.cooldownUntil) {
        return {
          allowed: false,
          rule: entry.trippedRule,
          reason: `collaboration channel cooling down until ${new Date(entry.cooldownUntil).toISOString()}`,
          channel,
          repeats: 0,
          windowCount: 0,
          cooldownUntil: entry.cooldownUntil,
        };
      }
      // 쿨다운 만료 — 윈도를 비우고 깨끗한 상태에서 다시 관측한다.
      entry.cooldownUntil = null;
      entry.trippedRule = null;
      entry.timestamps = [];
      entry.signatures.clear();
    }

    pruneWindow(entry, now - resolved.windowMs);

    const signature = contentSignature(content);
    const repeats = (entry.signatures.get(signature)?.length ?? 0) + 1;
    const windowCount = entry.timestamps.length + 1;

    if (repeats > resolved.maxRepeatsPerWindow) {
      return this.trip(entry, channel, 'echo-loop', now, resolved.cooldownMs, repeats, windowCount,
        `identical collaboration message repeated ${repeats}x within ${resolved.windowMs}ms`);
    }

    if (windowCount > resolved.maxMessagesPerWindow) {
      return this.trip(entry, channel, 'channel-burst', now, resolved.cooldownMs, repeats, windowCount,
        `collaboration channel sent ${windowCount} messages within ${resolved.windowMs}ms`);
    }

    entry.timestamps.push(now);
    const times = entry.signatures.get(signature) ?? [];
    times.push(now);
    entry.signatures.set(signature, times);

    return { allowed: true, rule: null, reason: null, channel, repeats, windowCount, cooldownUntil: null };
  }

  /** 채널(미지정 시 전체)의 관측 기록과 쿨다운을 지운다. */
  reset(channel?: string): void {
    if (channel == null) this.channels.clear();
    else this.channels.delete(channel);
  }

  snapshot(channel: string): { tracked: boolean; windowCount: number; cooldownUntil: number | null; trippedRule: CollaborationLoopRule | null } {
    const entry = this.channels.get(channel);
    if (!entry) return { tracked: false, windowCount: 0, cooldownUntil: null, trippedRule: null };
    return {
      tracked: true,
      windowCount: entry.timestamps.length,
      cooldownUntil: entry.cooldownUntil,
      trippedRule: entry.trippedRule,
    };
  }

  private trip(
    entry: ChannelWindow,
    channel: string,
    rule: CollaborationLoopRule,
    now: number,
    cooldownMs: number,
    repeats: number,
    windowCount: number,
    reason: string,
  ): CollaborationLoopDecision {
    entry.cooldownUntil = now + cooldownMs;
    entry.trippedRule = rule;
    // 트립을 유발한 메시지는 기록하지 않는다 — 쿨다운 만료 후 윈도가 초기화되므로
    // 남겨두면 다음 윈도의 카운트를 오염시킨다.
    return { allowed: false, rule, reason, channel, repeats, windowCount, cooldownUntil: entry.cooldownUntil };
  }

  private ensure(channel: string, now: number, maxTrackedChannels: number): ChannelWindow {
    const existing = this.channels.get(channel);
    if (existing) return existing;

    if (this.channels.size >= maxTrackedChannels) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [key, value] of this.channels) {
        if (value.lastSeenAt < oldestAt) {
          oldestAt = value.lastSeenAt;
          oldestKey = key;
        }
      }
      if (oldestKey != null) this.channels.delete(oldestKey);
    }

    const created: ChannelWindow = {
      timestamps: [],
      signatures: new Map(),
      cooldownUntil: null,
      trippedRule: null,
      lastSeenAt: now,
    };
    this.channels.set(channel, created);
    return created;
  }
}

export const collaborationLoopGuard = new CollaborationLoopGuard();

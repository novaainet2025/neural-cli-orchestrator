import { createHash } from 'node:crypto';

// ─── collaboration-msg-loop 방지 룰 ────────────────────────────────────────
//
// 근거(48h 실측, db/nco.db mesh_messages — cycle1 T1):
//   - 동일 (from,to) 채널에서 완전히 같은 본문이 60초 이내에 최대 72회 재전송됨
//   - 동일 채널 분당 메시지 최대 41건 (정상 협업 채널은 48h 총 64건 ≈ 1.3건/시간)
// cycle3 (2026-07-28): done:/status:/error:/question: 프로토콜 본문은 핸드오프 상태선이므로
//   일반 echo-loop(3회)보다 엄격한 protocol-echo(기본 1회)로 재전송을 차단한다.
//   점수 표본 실패(401/SIGINT)의 직접 원인은 아니나, mesh 프로토콜 에코 루프를 런타임에서 차단.
// 프로바이더 circuit_states와 분리된 인메모리 가드(DB 쓰기 없음).
// 롤백: NCO_MESH_COLLAB_LOOP_GUARD=off (재빌드 불필요) 또는 cli-mesh 배선 제거.

// cycle4 재검증 (2026-07-28, 고정 상한 2026-07-27T20:50:00Z, T1):
//   julianday()로 자른 정확한 48h mesh_messages 1008건을 실제 가드에 먹였을 때
//   기존 동작(flag off)은 7건(channel-burst 5 + echo-loop 2)을 차단했고, 모두
//   'nco-system'의 단방향 태스크 완료 통지였다(예: "❌ [task] codex 완료 (13.1s)").
//   면제 적용 시 차단은 0건이었다. 종전 3018/844 수치는 ISO T/Z 문자열 비교가
//   48h 밖 행을 포함한 결과이므로 근거로 재사용하지 않는다.
//   원인: 이 룰들은 협업 피어 간 에코 루프를 막으려고 만들어졌는데, 병렬 태스크가
//   동시 완료되면 시스템 통지원이 정상적으로 60초에 20건을 넘겨 burst로 오탐한다.
//   조치: 통지 발신자는 '볼륨' 룰(echo-loop/channel-burst)에서만 면제한다.
//   protocol-echo는 발신자와 무관하게 계속 적용된다 — 프로토콜 에코 루프가 원래 표적이다.
//   롤백: NCO_MESH_LOOP_GUARD_NOTIFIERS=off (면제 해제, cycle1 동작 복귀)
//         또는 목록 재정의 NCO_MESH_LOOP_GUARD_NOTIFIERS=nco-system,other

/** 룰이 차단 사유로 보고하는 루프 형태. */
export type CollaborationLoopRule = 'echo-loop' | 'channel-burst' | 'protocol-echo';

/** 협업 피어가 아니라 단방향 통지원인 발신 세션 — 볼륨 룰에서 면제된다. */
export const DEFAULT_NOTIFIER_SENDERS: readonly string[] = ['nco-system'];

const NOTIFIER_EXEMPTION_DISABLED = new Set(['off', 'none', '0', 'false']);

/** `from->to` 채널 키에서 발신 세션만 뽑는다. */
export function channelSender(channel: string): string {
  const idx = channel.indexOf('->');
  return idx < 0 ? channel : channel.slice(0, idx);
}

/**
 * 볼륨 룰 면제 발신자 집합. env로 재정의·해제 가능(재빌드 불필요).
 * off/none/0/false → 빈 집합 = 면제 없음(cycle1 동작).
 */
export function getNotifierSenders(
  raw: string | undefined = process.env.NCO_MESH_LOOP_GUARD_NOTIFIERS,
): ReadonlySet<string> {
  const value = raw?.trim();
  if (!value) return new Set(DEFAULT_NOTIFIER_SENDERS);
  if (NOTIFIER_EXEMPTION_DISABLED.has(value.toLowerCase())) return new Set();
  return new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
}

export interface CollaborationLoopRuleConfig {
  /** 슬라이딩 윈도 길이 (ms). */
  windowMs: number;
  /** 윈도 안에서 허용하는 동일 본문 재전송 횟수. 초과분이 echo-loop으로 차단된다. */
  maxRepeatsPerWindow: number;
  /**
   * 프로토콜 접두사(done:/status:/error:/question:) 본문의 동일 재전송 허용 횟수.
   * 초과분은 protocol-echo로 차단된다. 기본 1 = 최초 1회만 허용.
   */
  maxProtocolRepeatsPerWindow: number;
  /** 윈도 안에서 허용하는 채널 전체 메시지 수. 초과분이 channel-burst로 차단된다. */
  maxMessagesPerWindow: number;
  /** 룰이 트립된 뒤 해당 채널을 차단해 두는 시간 (ms). */
  cooldownMs: number;
  /** 추적 채널 수 상한 — 초과 시 가장 오래 쓰이지 않은 채널부터 제거(메모리 누수 방지). */
  maxTrackedChannels: number;
  /**
   * 볼륨 룰(echo-loop/channel-burst)에서 면제할 발신 세션.
   * protocol-echo에는 적용되지 않는다. 미지정 시 env/기본값을 쓴다.
   */
  notifierSenders?: ReadonlySet<string>;
}

export const DEFAULT_COLLABORATION_LOOP_CONFIG: CollaborationLoopRuleConfig = {
  windowMs: 60_000,
  maxRepeatsPerWindow: 3,
  maxProtocolRepeatsPerWindow: 1,
  maxMessagesPerWindow: 20,
  cooldownMs: 60_000,
  maxTrackedChannels: 500,
};

const PROTOCOL_PREFIX = /^(done|status|error|question)\s*:/i;

/** 공백 정규화 후 프로토콜 상태선인지 판정 (protocol-echo 임계값 선택용). */
export function isProtocolPrefixedContent(content: string): boolean {
  return PROTOCOL_PREFIX.test(content.replace(/\s+/g, ' ').trim());
}

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

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

export function collaborationChannelKey(fromSessionId: string, toSessionId: string): string {
  return `${fromSessionId}->${toSessionId}`;
}

/**
 * 런타임 킬스위치. off/false/0 이면 호출측이 가드를 건너뛴다.
 * 단위 테스트와 긴급 롤백용 — 기본은 활성.
 */
export function isCollaborationLoopGuardEnabled(
  toggle: string | undefined = process.env.NCO_MESH_COLLAB_LOOP_GUARD,
): boolean {
  const normalized = toggle?.trim().toLowerCase() ?? '';
  return !(normalized === '0' || normalized === 'false' || normalized === 'off');
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
      maxProtocolRepeatsPerWindow: normalizePositiveInteger(
        config?.maxProtocolRepeatsPerWindow,
        DEFAULT_COLLABORATION_LOOP_CONFIG.maxProtocolRepeatsPerWindow,
      ),
      maxMessagesPerWindow: normalizePositiveInteger(config?.maxMessagesPerWindow, DEFAULT_COLLABORATION_LOOP_CONFIG.maxMessagesPerWindow),
      cooldownMs: normalizePositiveInteger(config?.cooldownMs, DEFAULT_COLLABORATION_LOOP_CONFIG.cooldownMs),
      maxTrackedChannels: normalizePositiveInteger(config?.maxTrackedChannels, DEFAULT_COLLABORATION_LOOP_CONFIG.maxTrackedChannels),
      notifierSenders: config?.notifierSenders ?? getNotifierSenders(),
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
    const protocolPrefixed = isProtocolPrefixedContent(content);
    const repeatCap = protocolPrefixed
      ? resolved.maxProtocolRepeatsPerWindow
      : resolved.maxRepeatsPerWindow;
    const echoRule: CollaborationLoopRule = protocolPrefixed ? 'protocol-echo' : 'echo-loop';

    // 통지원 면제: channel-burst와 일반 echo-loop만 건너뛴다.
    // protocol-echo는 통지원에도 그대로 적용한다.
    const notifierExempt = resolved.notifierSenders?.has(channelSender(channel)) ?? false;

    if (!(notifierExempt && !protocolPrefixed) && repeats > repeatCap) {
      return this.trip(entry, channel, echoRule, now, resolved.cooldownMs, repeats, windowCount,
        protocolPrefixed
          ? `identical protocol collaboration message repeated ${repeats}x within ${resolved.windowMs}ms`
          : `identical collaboration message repeated ${repeats}x within ${resolved.windowMs}ms`);
    }

    if (!notifierExempt && windowCount > resolved.maxMessagesPerWindow) {
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

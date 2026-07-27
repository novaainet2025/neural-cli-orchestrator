import { getDb } from '../storage/database.js';
import { sharedState } from '../core/shared-state.js';
import { eventBus } from '../core/event-bus.js';
import { logDecision } from '../core/decision-log.js';
import {
  matchLearnedCircuitPattern,
  normalizeCircuitSignature,
  recordLearnedCircuitPatternApplication,
  recordLearningEvent,
} from '../core/failure-learning.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('circuit-breaker-registry');

export type CircuitState = 'closed' | 'open' | 'half-open';
export type CircuitReason = 'generic' | 'rate-limit' | 'quota' | 'auth';

export interface CircuitSnapshot {
  agentId: string;
  state: CircuitState;
  failureCount: number;
  openedAt: number | null;
  cooldownUntil: number | null;
  reason: CircuitReason | null;
}

export interface ClassifiedCircuitError {
  reason: CircuitReason;
  immediateOpen: boolean;
  resetTime: number | null;
  matchedText: string;
  learnedSignature?: string;
  learnedFailureThreshold?: number;
}

export interface CircuitBreakerPolicy {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenMaxAttempts?: number;
}

export type ProviderAvailability =
  | 'available'
  | 'gated:quota'
  | 'gated:rate-limit'
  | 'gated:auth'
  | 'gated:generic'
  | 'probe';

export interface ProviderAvailabilitySnapshot {
  agentId: string;
  status: ProviderAvailability;
  available: boolean;
  reason: CircuitReason | null;
  circuitState: CircuitState;
  cooldownUntil: string | null;
}

interface CircuitRow {
  agent_id: string;
  state: CircuitState;
  failure_count: number;
  opened_at: number | null;
  cooldown_until: number | null;
  reason: CircuitReason | null;
}

const BASE_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 30 * 60_000;
const QUOTA_FALLBACK_COOLDOWN_MS = 60 * 60_000;
const FAILURE_THRESHOLD = 3;
// P0-2: half-open은 자가복구 분기가 없어 프로브가 영영 실행되지 않으면(예: 태스크 유입 없음)
// 영구 고착된다(DB 실측: copilot|half-open|2026-07-21, 5일째). 5분 이상 half-open에 머물면
// closed로 되돌려 다음 canExecute() 호출이 새 프로브를 시도할 수 있게 한다.
const HALF_OPEN_TTL_MS = 5 * 60_000;

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

const AUTH_PATTERNS = [
  /\binvalid api key\b/i,
  /\binvalid[_ -]?key\b/i,
  /\bincorrect api key\b/i,
  /\bunauthorized\b/i,
  /\b401\b/i,
  /\bauth(?:entication)? failed\b/i,
  /\buser not found\b/i, // openrouter 401 본문 — 401 리터럴 없이 이 문구만 전파될 때 generic 오분류 (snt 실측)
  // preflight 실패는 키를 고치기 전엔 자가치유 불가 — 60s generic 쿨다운 재시도 낭비 대신 auth immediateOpen
  /\bcredential preflight failed\b/i,
];

const QUOTA_PATTERNS = [
  /\bquota\b/i,
  /\bquota exceeded\b/i,
  /\bmonthly quota\b/i,
  /\busage limit\b/i,
  /\bhit your usage limit\b/i,
  /\bcredit balance is too low\b/i,
];

const RATE_LIMIT_PATTERNS = [
  /\b429\b/i,
  /\brate limit\b/i,
  /\btoo many requests\b/i,
];

function defaultSnapshot(agentId: string): CircuitSnapshot {
  return {
    agentId,
    state: 'closed',
    failureCount: 0,
    openedAt: null,
    cooldownUntil: null,
    reason: null,
  };
}

function describeReason(reason: CircuitReason | null): string | null {
  switch (reason) {
    case 'auth': return 'auth';
    case 'quota': return 'quota';
    case 'rate-limit': return 'rate-limit';
    case 'generic': return 'generic';
    default: return null;
  }
}

function parseAbsoluteResetTime(message: string): number | null {
  const isoMatch = message.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/);
  if (isoMatch) {
    const ms = Date.parse(isoMatch[0]);
    return Number.isFinite(ms) ? ms : null;
  }

  const retryAfter = message.match(/\bretry[- ]after[: ]+(\d+)\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs)\b/i);
  if (!retryAfter) return null;

  const amount = Number(retryAfter[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = retryAfter[2].toLowerCase();
  const multiplier = unit.startsWith('sec')
    ? 1000
    : unit.startsWith('min')
      ? 60_000
      : 60 * 60_000;

  return Date.now() + amount * multiplier;
}

export function classifyCircuitError(raw: string | null | undefined): ClassifiedCircuitError | null {
  const message = raw?.trim();
  if (!message) return null;

  const resetTime = parseAbsoluteResetTime(message);

  for (const pattern of AUTH_PATTERNS) {
    const matched = message.match(pattern);
    if (matched) {
      return { reason: 'auth', immediateOpen: true, resetTime: null, matchedText: matched[0] };
    }
  }

  for (const pattern of QUOTA_PATTERNS) {
    const matched = message.match(pattern);
    if (matched) {
      return { reason: 'quota', immediateOpen: true, resetTime, matchedText: matched[0] };
    }
  }

  for (const pattern of RATE_LIMIT_PATTERNS) {
    const matched = message.match(pattern);
    if (matched) {
      return { reason: 'rate-limit', immediateOpen: true, resetTime, matchedText: matched[0] };
    }
  }

  const learned = matchLearnedCircuitPattern(message);
  if (learned) {
    return {
      // Learned signatures originated from the unclassified path. They remain
      // thresholded generic failures; only explicit provider patterns above
      // may opt into immediate opening.
      reason: learned.reason,
      immediateOpen: learned.immediateOpen,
      resetTime: learned.immediateOpen ? resetTime : null,
      matchedText: learned.signature,
      learnedSignature: learned.signature,
      learnedFailureThreshold: learned.failureThreshold,
    };
  }

  return null;
}

class CircuitBreakerRegistry {
  private states = new Map<string, CircuitSnapshot>();
  // P0-3: half-open 프로브 슬롯의 in-flight 세마포어 (max halfOpenMaxAttempts, 기본 1).
  // canExecute()가 half-open 분기에서 슬롯을 획득(+1)하면 그 실행을 끝까지 마친 호출자가
  // 반드시 releaseProbeSlot()으로 반납(-1)해야 한다 — 반납 누락 시 유일한 슬롯이 영구
  // 소진되어 half-open이 고착된다(P0-1/P0-2가 다루는 증상의 근본 원인).
  private halfOpenAttempts = new Map<string, number>();
  // AgentManager가 슬롯을 실제 실행의 AbortSignal에 결속한다. TTL이 지나도 signal이
  // 살아 있으면 장시간 프로브가 진행 중인 것이므로 half-open을 유지한다. 실행이
  // 중단되거나 결속되지 않은 고아 슬롯은 기존 5분 안전망이 회수한다.
  private halfOpenProbeSignals = new Map<string, Set<AbortSignal>>();

  async restore(agentIds: string[]): Promise<void> {
    for (const agentId of agentIds) {
      this.ensure(agentId);
    }

    try {
      const db = getDb();
      const placeholders = agentIds.map(() => '?').join(', ');
      const query = placeholders.length > 0
        ? `SELECT agent_id, state, failure_count, opened_at, cooldown_until, reason FROM circuit_states WHERE agent_id IN (${placeholders})`
        : 'SELECT agent_id, state, failure_count, opened_at, cooldown_until, reason FROM circuit_states';
      const rows = db.prepare(query).all(...agentIds) as CircuitRow[];

      for (const row of rows) {
        this.states.set(row.agent_id, {
          agentId: row.agent_id,
          state: row.state,
          failureCount: Number(row.failure_count || 0),
          openedAt: row.opened_at == null ? null : Number(row.opened_at),
          cooldownUntil: row.cooldown_until == null ? null : Number(row.cooldown_until),
          reason: row.reason ?? null,
        });
      }
    } catch (err) {
      log.warn({ err }, 'Failed to restore circuit states from SQLite');
    }

    await Promise.all(agentIds.map(async agentId => this.syncSharedState(agentId)));
  }

  canExecute(agentId: string, policy: CircuitBreakerPolicy = {}): boolean {
    const current = this.ensure(agentId);
    if (current.state === 'closed') return true;
    if (current.state === 'half-open') {
      const attempts = this.halfOpenAttempts.get(agentId) ?? 0;
      const maxAttempts = normalizePositiveInteger(policy.halfOpenMaxAttempts, 1);
      if (attempts >= maxAttempts) return false;
      this.halfOpenAttempts.set(agentId, attempts + 1);
      return true;
    }
    if (current.reason === 'auth') return false;
    if (current.cooldownUntil == null) return false;
    if (Date.now() < current.cooldownUntil) return false;

    const next: CircuitSnapshot = {
      ...current,
      state: 'half-open',
      failureCount: 0,
      // half-open 체류 TTL은 최초 open 시각이 아니라 실제 probe 진입 시각부터 잰다.
      openedAt: Date.now(),
    };
    this.commit(next, 'Circuit moved to half-open');
    this.halfOpenAttempts.set(agentId, 1);
    return true;
  }

  recordSuccess(agentId: string): void {
    const current = this.ensure(agentId);
    if (current.state === 'closed' && current.failureCount === 0) return;

    const next: CircuitSnapshot = {
      agentId,
      state: 'closed',
      failureCount: 0,
      openedAt: null,
      cooldownUntil: null,
      reason: null,
    };
    this.commit(next, 'Circuit closed after success');

    if (current.state === 'half-open' || current.state === 'open') {
      void eventBus.publish({
        type: 'provider:available',
        agentId,
        previousState: current.state,
        state: 'closed',
        reasonCleared: current.reason,
      });
    }
  }

  recordFailure(agentId: string, rawError?: string, policy: CircuitBreakerPolicy = {}): void {
    const current = this.ensure(agentId);
    const classified = classifyCircuitError(rawError);
    const configuredFailureThreshold = normalizePositiveInteger(policy.failureThreshold, FAILURE_THRESHOLD);
    const failureThreshold = classified?.learnedFailureThreshold == null
      ? configuredFailureThreshold
      : Math.min(
          configuredFailureThreshold,
          normalizePositiveInteger(classified.learnedFailureThreshold, configuredFailureThreshold),
        );

    if (classified?.learnedSignature) {
      const learned = matchLearnedCircuitPattern(classified.learnedSignature);
      if (learned) {
        recordLearnedCircuitPatternApplication(agentId, learned);
      }
    } else if (!classified) {
      const signature = normalizeCircuitSignature(rawError);
      if (signature) {
        recordLearningEvent({
          agentId,
          eventType: 'circuit_unclassified',
          pattern: signature,
          context: { failureCountBefore: current.failureCount },
        });
      }
    }

    if (classified?.reason === 'auth') {
      const next: CircuitSnapshot = {
        agentId,
        state: 'open',
        failureCount: Math.max(1, current.failureCount + 1),
        openedAt: Date.now(),
        cooldownUntil: null,
        reason: 'auth',
      };
      this.commit(next, 'Circuit opened on auth failure');
      return;
    }

    if (classified?.immediateOpen) {
      const next = this.openSnapshot(current, classified.reason, classified.resetTime, policy.resetTimeoutMs);
      this.commit(next, 'Circuit opened on classified provider failure');
      return;
    }

    if (current.state === 'half-open') {
      const next = this.openSnapshot(current, 'generic', null, policy.resetTimeoutMs);
      next.failureCount = 1;
      this.commit(next, 'Circuit re-opened after half-open probe failed');
      return;
    }

    const failures = current.failureCount + 1;
    if (failures >= failureThreshold) {
      const next = this.openSnapshot({ ...current, failureCount: failures }, 'generic', null, policy.resetTimeoutMs);
      next.failureCount = failures;
      this.commit(next, 'Circuit opened after consecutive failures');
      return;
    }

    const next: CircuitSnapshot = {
      ...current,
      state: 'closed',
      failureCount: failures,
      reason: 'generic',
    };
    this.commit(next, 'Circuit failure count incremented');
  }

  reset(agentId: string): void {
    this.halfOpenAttempts.delete(agentId);
    this.halfOpenProbeSignals.delete(agentId);
    const next = defaultSnapshot(agentId);
    this.commit(next, 'Circuit manually reset');
  }

  bindProbeSlot(agentId: string, signal: AbortSignal): boolean {
    const current = this.ensure(agentId);
    if (
      current.state !== 'half-open'
      || (this.halfOpenAttempts.get(agentId) ?? 0) <= 0
    ) {
      return false;
    }
    const signals = this.halfOpenProbeSignals.get(agentId) ?? new Set<AbortSignal>();
    signals.add(signal);
    this.halfOpenProbeSignals.set(agentId, signals);
    return true;
  }

  /**
   * P0-3: half-open 프로브 슬롯 반납. canExecute()가 half-open 분기에서 슬롯을 실제로
   * 획득했을 때만(호출측 slotHeld 가드) 호출해야 한다 — 획득하지 않은 경로에서 호출하면
   * 카운터가 0 미만으로 내려가 이후 canExecute()가 항상 true를 반환(무제한 동시 실행)하게
   * 되므로, 여기서는 0 이하로 내려가지 않도록 방어하고 그 이하면 엔트리를 제거한다.
   */
  releaseProbeSlot(agentId: string, signal?: AbortSignal): void {
    const signals = this.halfOpenProbeSignals.get(agentId);
    if (signals) {
      if (signal) {
        signals.delete(signal);
      } else {
        const first = signals.values().next().value as AbortSignal | undefined;
        if (first) signals.delete(first);
      }
      if (signals.size === 0) this.halfOpenProbeSignals.delete(agentId);
    }

    const attempts = this.halfOpenAttempts.get(agentId);
    if (attempts == null) return;
    const next = attempts - 1;
    if (next <= 0) {
      this.halfOpenAttempts.delete(agentId);
    } else {
      this.halfOpenAttempts.set(agentId, next);
    }
  }

  /**
   * cooldown이 만료된 open 회로(비-auth)를 closed로 자가복구한다.
   * 상태 전이는 canExecute()에서만 lazy하게 일어나므로, 태스크 유입이 없는 idle
   * 프로바이더는 cooldown이 하루 전에 지나도 'open'에 영구 고착 → 대시보드가 'error'/
   * '해제 대기'로 잘못 표시되던 버그(2026-07-26 nova-macstudio 실측: 6개 프로바이더가
   * 만료 17~27h 경과 후에도 available=false)를 수정한다. 리포팅 메서드에서 호출.
   * auth는 cooldownUntil=null이라 대상 아님(키 수정 전까지 유지가 정상).
   *
   * P0-2: half-open도 자가복구 분기가 없으면 영구 고착될 수 있다(DB 실측:
   * copilot|half-open|2026-07-21, 5일째 — 유일한 프로브 슬롯을 점유한 태스크가 결과를
   * 기록하지 않고 사라진 경우). HALF_OPEN_TTL_MS(5분) 초과 후 살아 있는 실행 signal이
   * 없는 고아 슬롯만 closed로 되돌려 다음 canExecute() 호출이 새 프로브를 시도할 수
   * 있게 하는 사후 안전망이다(구조적 해결은 P0-3의 프로브 슬롯 세마포어).
   */
  private recoverIfExpired(agentId: string): CircuitSnapshot {
    const current = this.ensure(agentId);
    const hasLiveProbe = Array.from(this.halfOpenProbeSignals.get(agentId) ?? [])
      .some(signal => !signal.aborted);
    if (
      (current.state === 'open' &&
        current.reason !== 'auth' &&
        current.cooldownUntil != null &&
        Date.now() >= current.cooldownUntil) ||
      (current.state === 'half-open' &&
        current.openedAt != null &&
        Date.now() - current.openedAt > HALF_OPEN_TTL_MS &&
        !hasLiveProbe)
    ) {
      const next: CircuitSnapshot = {
        agentId,
        state: 'closed',
        failureCount: 0,
        openedAt: null,
        cooldownUntil: null,
        reason: null,
      };
      this.commit(next, 'Circuit auto-recovered after cooldown expiry (idle)');
      void eventBus.publish({
        type: 'provider:available',
        agentId,
        previousState: current.state,
        state: 'closed',
        reasonCleared: current.reason,
      });
      return next;
    }
    return current;
  }

  getSnapshot(agentId: string): CircuitSnapshot {
    return { ...this.recoverIfExpired(agentId) };
  }

  getAvailability(agentId: string): ProviderAvailabilitySnapshot {
    const snapshot = this.recoverIfExpired(agentId);
    const isOpenProbeEligible = snapshot.state === 'open'
      && snapshot.reason !== 'auth'
      && snapshot.cooldownUntil != null
      && Date.now() >= snapshot.cooldownUntil;
    const status = snapshot.state === 'half-open'
      || isOpenProbeEligible
      ? 'probe'
      : snapshot.state === 'closed'
        ? 'available'
        : snapshot.reason === 'quota'
          ? 'gated:quota'
          : snapshot.reason === 'rate-limit'
            ? 'gated:rate-limit'
            : snapshot.reason === 'auth'
              ? 'gated:auth'
              : 'gated:generic';

    return {
      agentId,
      status,
      available: status === 'available',
      reason: snapshot.reason,
      circuitState: snapshot.state,
      cooldownUntil: snapshot.cooldownUntil == null ? null : new Date(snapshot.cooldownUntil).toISOString(),
    };
  }

  listSnapshots(agentIds?: string[]): CircuitSnapshot[] {
    if (agentIds) {
      return agentIds.map(agentId => this.getSnapshot(agentId));
    }
    // 전량 조회 시에도 만료 회로를 자가복구 후 반환
    return Array.from(this.states.keys()).map(agentId => ({ ...this.recoverIfExpired(agentId) }));
  }

  private ensure(agentId: string): CircuitSnapshot {
    const existing = this.states.get(agentId);
    if (existing) return existing;
    const created = defaultSnapshot(agentId);
    this.states.set(agentId, created);
    return created;
  }

  private openSnapshot(
    current: CircuitSnapshot,
    reason: CircuitReason,
    resetTime: number | null,
    configuredResetTimeoutMs?: number,
  ): CircuitSnapshot {
    const now = Date.now();
    const resetTimeoutMs = normalizePositiveInteger(configuredResetTimeoutMs, BASE_COOLDOWN_MS);
    let cooldownUntil: number | null;

    if (reason === 'auth') {
      cooldownUntil = null;
    } else if (reason === 'quota') {
      cooldownUntil = resetTime ?? (now + QUOTA_FALLBACK_COOLDOWN_MS);
    } else if (reason === 'rate-limit') {
      cooldownUntil = resetTime ?? (now + resetTimeoutMs);
    } else {
      const previousDuration = current.openedAt != null && current.cooldownUntil != null
        ? Math.max(0, current.cooldownUntil - current.openedAt)
        : 0;
      const duration = previousDuration > 0
        ? Math.min(previousDuration * 2, Math.max(MAX_COOLDOWN_MS, resetTimeoutMs))
        : resetTimeoutMs;
      cooldownUntil = now + duration;
    }

    return {
      agentId: current.agentId,
      state: 'open',
      failureCount: current.failureCount,
      openedAt: now,
      cooldownUntil,
      reason,
    };
  }

  private commit(snapshot: CircuitSnapshot, message: string): void {
    if (snapshot.state !== 'half-open') {
      this.halfOpenAttempts.delete(snapshot.agentId);
      this.halfOpenProbeSignals.delete(snapshot.agentId);
    }
    this.states.set(snapshot.agentId, snapshot);
    this.persist(snapshot);
    logDecision({ phase: 'circuit-breaker', decision: `circuit:${snapshot.state}`, reason: message, actor: snapshot.agentId });
    recordLearningEvent({
      agentId: snapshot.agentId,
      eventType: 'circuit_commit',
      pattern: `${snapshot.state}:${snapshot.reason ?? 'none'}`,
      context: {
        message,
        failureCount: snapshot.failureCount,
        cooldownUntil: snapshot.cooldownUntil,
      },
    });
    void this.syncSharedState(snapshot.agentId);
    log.info({
      agentId: snapshot.agentId,
      state: snapshot.state,
      failureCount: snapshot.failureCount,
      cooldownUntil: snapshot.cooldownUntil,
      reason: snapshot.reason,
    }, message);
  }

  private persist(snapshot: CircuitSnapshot): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO circuit_states (agent_id, state, failure_count, opened_at, cooldown_until, reason)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          state=excluded.state,
          failure_count=excluded.failure_count,
          opened_at=excluded.opened_at,
          cooldown_until=excluded.cooldown_until,
          reason=excluded.reason
      `).run(
        snapshot.agentId,
        snapshot.state,
        snapshot.failureCount,
        snapshot.openedAt,
        snapshot.cooldownUntil,
        snapshot.reason,
      );
    } catch (err) {
      log.warn({ err, agentId: snapshot.agentId }, 'Failed to persist circuit state');
    }
  }

  private async syncSharedState(agentId: string): Promise<void> {
    const snapshot = this.ensure(agentId);
    await sharedState.setAgentState(agentId, {
      health: {
        consecutiveFailures: snapshot.failureCount,
        circuitState: snapshot.state,
        lastError: describeReason(snapshot.reason),
      },
    });
  }
}

export const circuitBreakerRegistry = new CircuitBreakerRegistry();

import { getDb } from '../storage/database.js';
import { sharedState } from '../core/shared-state.js';
import { eventBus } from '../core/event-bus.js';
import { logDecision } from '../core/decision-log.js';
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

  return null;
}

class CircuitBreakerRegistry {
  private states = new Map<string, CircuitSnapshot>();

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

  canExecute(agentId: string): boolean {
    const current = this.ensure(agentId);
    if (current.state !== 'open') return true;
    if (current.reason === 'auth') return false;
    if (current.cooldownUntil == null) return false;
    if (Date.now() < current.cooldownUntil) return false;

    const next: CircuitSnapshot = {
      ...current,
      state: 'half-open',
      failureCount: 0,
    };
    this.commit(next, 'Circuit moved to half-open');
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

  recordFailure(agentId: string, rawError?: string): void {
    const current = this.ensure(agentId);
    const classified = classifyCircuitError(rawError);

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
      const next = this.openSnapshot(current, classified.reason, classified.resetTime);
      this.commit(next, 'Circuit opened on classified provider failure');
      return;
    }

    if (current.state === 'half-open') {
      const next = this.openSnapshot(current, 'generic', null);
      next.failureCount = 1;
      this.commit(next, 'Circuit re-opened after half-open probe failed');
      return;
    }

    const failures = current.failureCount + 1;
    if (failures >= FAILURE_THRESHOLD) {
      const next = this.openSnapshot({ ...current, failureCount: failures }, 'generic', null);
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
    const next = defaultSnapshot(agentId);
    this.commit(next, 'Circuit manually reset');
  }

  getSnapshot(agentId: string): CircuitSnapshot {
    return { ...this.ensure(agentId) };
  }

  getAvailability(agentId: string): ProviderAvailabilitySnapshot {
    const snapshot = this.ensure(agentId);
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
    return Array.from(this.states.values()).map(snapshot => ({ ...snapshot }));
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
  ): CircuitSnapshot {
    const now = Date.now();
    let cooldownUntil: number | null;

    if (reason === 'auth') {
      cooldownUntil = null;
    } else if (reason === 'quota') {
      cooldownUntil = resetTime ?? (now + QUOTA_FALLBACK_COOLDOWN_MS);
    } else if (reason === 'rate-limit') {
      cooldownUntil = resetTime ?? (now + BASE_COOLDOWN_MS);
    } else {
      const previousDuration = current.openedAt != null && current.cooldownUntil != null
        ? Math.max(0, current.cooldownUntil - current.openedAt)
        : 0;
      const duration = previousDuration > 0
        ? Math.min(previousDuration * 2, MAX_COOLDOWN_MS)
        : BASE_COOLDOWN_MS;
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
    this.states.set(snapshot.agentId, snapshot);
    this.persist(snapshot);
    logDecision({ phase: 'circuit-breaker', decision: `circuit:${snapshot.state}`, reason: message, actor: snapshot.agentId });
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

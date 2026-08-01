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

export interface ProviderInferenceEvidence {
  success: boolean;
  observedAt: string;
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
  /\bweekly limit\b/i,
  /\busage limit\b/i,
  /\bhit your usage limit\b/i,
  /\bcredit balance is too low\b/i,
];

const RATE_LIMIT_PATTERNS = [
  /\b429\b/i,
  /\brate limit\b/i,
  /\btoo many requests\b/i,
  /\bqueue_wait_timeout\b/i,
  /\bprovider .* busy\b/i,
];

const QUALITY_GATE_PATTERNS = [
  /\bquality_rejected\b/i,
  /\bquality.reject/i,
  /\bFORMAT_MISMATCH\b/i,
  /\bEvidenceGateError\b/i,
  /\bevidence.gate/i,
  /\bmissing evidence\b/i,
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
  if (retryAfter) {
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

  // Claude CLI quota errors report a daily reset without an ISO timestamp:
  // "You've hit your weekly limit · resets 4am (Asia/Seoul)".
  // Preserve the quota gate until that next wall-clock reset instead of using
  // the one-hour fallback and prematurely routing another real task to it.
  const seoulReset = message.match(
    /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(Asia\/Seoul\)/i,
  );
  if (!seoulReset) return null;

  const twelveHour = Number(seoulReset[1]);
  const minute = Number(seoulReset[2] ?? '0');
  if (twelveHour < 1 || twelveHour > 12 || minute < 0 || minute > 59) return null;

  const meridiem = seoulReset[3].toLowerCase();
  const hour = (twelveHour % 12) + (meridiem === 'pm' ? 12 : 0);
  const now = Date.now();
  const seoulNow = new Date(now + 9 * 60 * 60_000);
  let candidate = Date.UTC(
    seoulNow.getUTCFullYear(),
    seoulNow.getUTCMonth(),
    seoulNow.getUTCDate(),
    hour,
    minute,
  ) - 9 * 60 * 60_000;

  if (candidate <= now) candidate += 24 * 60 * 60_000;
  return candidate;
}

// ─── 명령 에코(argv) 오탐 차단 ──────────────────────────────────────────────
//
// execa의 shortMessage는 실패한 CLI의 **인자 전체(= 프롬프트 전문)** 를 그대로 포함한다
// ("Command failed with exit code 1: claude … -p '<프롬프트 4000자>'"). 분류기가 그 본문까지
// 훑으면 프롬프트가 인용한 평범한 단어가 프로바이더 장애 신호로 오인된다.
//
// 실측(2026-07-29 06:02:05Z, db/nco.db circuit_states.claude-code):
//   error = "claude-code: subprocess cancelled: Command was canceled: claude … Roth IRA/401(k) …"
//   → AUTH_PATTERNS의 /\b401\b/가 프롬프트 안 '401(k)'에 매칭 → reason='auth'
//   → auth는 cooldownUntil=null + recoverIfExpired 제외라 **수동 reset 전까지 영구 gated**.
//   대시보드(:5173)는 gate.available===false를 그대로 배지로 그려 "⛔ 리밋"으로 표기했다.
//
// 인증·쿼터 신호는 우리가 보낸 argv가 아니라 프로바이더 stdout(오류 봉투)에 실린다. 봉투는
// recordFailure(providerOutput) 인자로 따로 분류되므로, argv 제거는 탐지력 손실이 없다.
// 같은 계열 오탐의 선례: agent-manager.ts의 "성공 출력 <300자에만 분류" 가드(2026-07-03 codex).
// 롤백: NCO_CB_STRIP_ARGV=off (재빌드 불필요) 또는 이 함수와 호출부 1줄 제거.
const COMMAND_ECHO_RE = /(Command (?:failed|was canceled|was killed)[^:\n]{0,60}:)[\s\S]*$/i;
const ARGV_STRIP_DISABLED = new Set(['0', 'false', 'off']);

export function stripCommandEcho(raw: string): string {
  if (ARGV_STRIP_DISABLED.has((process.env.NCO_CB_STRIP_ARGV ?? '').trim().toLowerCase())) {
    return raw;
  }
  return raw.replace(COMMAND_ECHO_RE, '$1');
}

export function classifyCircuitError(raw: string | null | undefined): ClassifiedCircuitError | null {
  const message = raw ? stripCommandEcho(raw).trim() : '';
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

  for (const pattern of QUALITY_GATE_PATTERNS) {
    const matched = message.match(pattern);
    if (matched) {
      return { reason: 'generic', immediateOpen: true, resetTime: null, matchedText: matched[0] };
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

// ─── provider 오류 봉투(error envelope) 분류 ──────────────────────────────────
//
// 문제(2026-07-28 실측, db/nco.db): CLI 프로바이더가 HTTP 401을 받고 죽으면 인증 신호는
// **stdout의 구조화된 오류 봉투**에만 남는다. 반면 agent-manager가 서킷에 넘기는
// `errorMessage`는 execa의 shortMessage — 즉 `Command failed with exit code 1: opencode run
// --format json '<프롬프트 전문>'`이라는 **명령 에코**다. 그래서 분류기는 인증 실패를 보지
// 못하고 generic 임계치(3연속) 경로로 떨어진다.
//  실측: 2026-07-27 17:19~17:30 UTC 자격증명 장애 창에서 error가 'CLI failed exit=' 이고
//   response가 '{"type":"error"…' 로 시작하는 행 8건 전수에 대해
//   classifyCircuitError(error) = null (전부), classifyCircuitError(response) = auth 7건.
//   그 사이 circuit_states.opencode의 reason은 'generic'이었고(실측 스냅샷), 60초 쿨다운마다
//   half-open 프로브가 **실제 팀 태스크**를 소모하며 같은 401을 반복했다
//   (task_KkeE7Ly_A5hC1K2n 17:29:09 → task_p2V_WOaQg3z-gdGx 17:29:59, 후자는
//   team_gov-evolution-learning의 48h 계상 실패 1건).
//
// 의도적으로 reason은 'auth'가 아니라 'generic'으로 승격한다:
//  reason='auth'는 cooldownUntil=null + recoverIfExpired 제외 + getAvailability='gated:auth'라
//  헬스 프로브의 recordSuccess 경로에도 걸리지 않아 **수동 reset 전까지 영구 개방**이다
//  (실측: circuit_states.openai = open/auth/failure_count=1860, opened_at 이후 자가복구 0회).
//  fleet 전역 자격증명 장애는 claude-code·cursor-agent·opencode에 동시 발생했으므로,
//  봉투 하나로 영구 개방을 걸면 장애 복구 후에도 fleet이 스스로 못 돌아온다. 따라서
//  '즉시 개방 + 기존 지수 백오프(60s→120s→…) + half-open 자가복구'라는 유계 동작만 취한다.
//  기대 효과는 임계치 3 대기 없이 첫 하드-401에서 바로 게이팅되는 것 = 반복 소모 차단.
// 롤백: 런타임 즉시 → NCO_CB_ERROR_ENVELOPE=off (재빌드 불필요). 코드 → 이 절과
//  recordFailure의 providerOutput 인자·분기를 제거하면 정확히 이전 동작.
const ERROR_ENVELOPE_DISABLED = new Set(['0', 'false', 'off']);

/** 이 길이를 넘는 출력은 프로바이더 오류 봉투가 아니라 팀 산출물로 보고 파싱하지 않는다. */
const ERROR_ENVELOPE_MAX_CHARS = 8_192;

/** 봉투 안에서 분류 신호로 인정하는 키 — 임의 문자열(요약·본문)을 신호로 쓰지 않기 위한 화이트리스트. */
const ENVELOPE_SIGNAL_KEYS = new Set(['message', 'type', 'name', 'code', 'detail', 'responseBody']);
const ENVELOPE_STATUS_KEYS = new Set(['statusCode', 'status', 'status_code']);
const ENVELOPE_MAX_DEPTH = 6;

export function isProviderErrorEnvelopeGateEnabled(
  toggle: string | undefined = process.env.NCO_CB_ERROR_ENVELOPE,
): boolean {
  return !ERROR_ENVELOPE_DISABLED.has(toggle?.trim().toLowerCase() ?? '');
}

function collectEnvelopeSignal(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > ENVELOPE_MAX_DEPTH || out.length > 64) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectEnvelopeSignal(item, depth + 1, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === 'string' && ENVELOPE_SIGNAL_KEYS.has(key)) {
      out.push(child.slice(0, 500));
    } else if (typeof child === 'number' && ENVELOPE_STATUS_KEYS.has(key)) {
      out.push(`HTTP ${child}`);
    } else if (child && typeof child === 'object') {
      collectEnvelopeSignal(child, depth + 1, out);
    }
  }
  return out;
}

/**
 * 프로바이더 stdout이 **오직** 구조화된 오류 봉투 하나일 때만 인증 실패로 분류한다.
 * 3중 가드: (a) trim 후 '{'로 시작하고 '}'로 끝날 것, (b) JSON.parse 전체 성공 + type==='error',
 * (c) 화이트리스트 키에서 모은 신호가 AUTH_PATTERNS에 걸릴 것. (a)+(b) 때문에 401 문자열을
 * *인용*한 팀 보고서 본문은 절대 매칭되지 않는다(오탐 차단 — 이 fleet의 학습·프로토콜 팀은
 * 오류 문자열을 본문에 인용하는 일이 잦다).
 * 반환 reason은 의도적으로 'generic'이다(위 주석의 영구 개방 회피 근거 참조).
 */
export function classifyProviderErrorEnvelope(
  rawOutput: string | null | undefined,
  toggle: string | undefined = process.env.NCO_CB_ERROR_ENVELOPE,
): ClassifiedCircuitError | null {
  if (!isProviderErrorEnvelopeGateEnabled(toggle)) return null;

  const text = rawOutput?.trim();
  if (!text || text.length > ERROR_ENVELOPE_MAX_CHARS) return null;
  if (!text.startsWith('{') || !text.endsWith('}')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if ((parsed as { type?: unknown }).type !== 'error') return null;

  const signal = collectEnvelopeSignal(parsed).join(' | ');
  const classified = classifyCircuitError(signal);
  // 관측된 사례(하드 401)만 대상으로 좁힌다. quota/rate-limit 봉투는 48h 표본에 없었고
  // 각각 1시간·resetTime 쿨다운이라 오탐 비용이 커서 이번 범위에서 제외한다.
  if (!classified || classified.reason !== 'auth') return null;

  return {
    reason: 'generic',
    immediateOpen: true,
    resetTime: null,
    matchedText: `provider error envelope: ${classified.matchedText}`,
  };
}

class CircuitBreakerRegistry {
  private states = new Map<string, CircuitSnapshot>();
  /** Process-local evidence only: a restart intentionally returns to unknown until a real inference succeeds. */
  private inferenceEvidence = new Map<string, { success: boolean; observedAt: number }>();
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
    // Reclaim stale/expired state before acquiring a half-open slot. If this
    // happened after attempts++ then a following observer(getSnapshot) could
    // clear the freshly acquired slot and allow concurrent probes.
    const current = this.recoverIfExpired(agentId);
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

  /** Record only a validated model/CLI completion, never a GET health check or bare heartbeat. */
  recordInferenceSuccess(agentId: string, observedAt = Date.now()): void {
    if (!Number.isFinite(observedAt)) return;
    this.inferenceEvidence.set(agentId, { success: true, observedAt });
  }

  /** Record only a terminal model/CLI attempt, not a transport health GET. */
  recordInferenceFailure(agentId: string, observedAt = Date.now()): void {
    if (!Number.isFinite(observedAt)) return;
    this.inferenceEvidence.set(agentId, { success: false, observedAt });
  }

  getInferenceEvidence(agentId: string): ProviderInferenceEvidence | null {
    const evidence = this.inferenceEvidence.get(agentId);
    return evidence === undefined
      ? null
      : { success: evidence.success, observedAt: new Date(evidence.observedAt).toISOString() };
  }

  clearInferenceEvidence(agentId: string): void {
    this.inferenceEvidence.delete(agentId);
  }

  /**
   * @param providerOutput 실행이 남긴 terminal 출력(= tasks.response로 저장되는 값).
   *   rawError가 분류되지 않을 때만 오류 봉투 분류에 쓰인다(기존 동작 보존).
   */
  recordFailure(
    agentId: string,
    rawError?: string,
    policy: CircuitBreakerPolicy = {},
    providerOutput?: string,
  ): void {
    const current = this.ensure(agentId);
    const classified = classifyCircuitError(rawError);
    const envelope = classified ? null : classifyProviderErrorEnvelope(providerOutput);
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
    } else if (!classified && !envelope) {
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

    if (envelope) {
      const next = this.openSnapshot(current, 'generic', null, policy.resetTimeoutMs);
      next.failureCount = Math.max(1, current.failureCount + 1);
      this.commit(next, `Circuit opened on provider error envelope (${envelope.matchedText})`);
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
    this.clearInferenceEvidence(agentId);
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
   * cooldown이 만료된 open 회로(비-auth)를 probe-ready half-open으로 전환한다.
   * 관측(getSnapshot/listSnapshots)이 곧바로 closed로 만들면 스케줄러의 동시 호출이
   * 모두 통과하는 thundering herd가 발생한다. half-open + 빈 세마포어로 전환하면
   * 대시보드는 복구 가능 상태를 표시하면서도 canExecute()가 정확히 한 호출만 허용한다.
   * provider:available은 실제 프로브 성공(recordSuccess) 전에는 발행하지 않는다.
   * auth는 cooldownUntil=null이라 대상 아님(키 수정 전까지 유지가 정상).
   *
   * P0-2: half-open도 자가복구 분기가 없으면 영구 고착될 수 있다(DB 실측:
   * copilot|half-open|2026-07-21, 5일째 — 유일한 프로브 슬롯을 점유한 태스크가 결과를
   * 기록하지 않고 사라진 경우). HALF_OPEN_TTL_MS(5분) 초과 후 살아 있는 실행 signal이
   * 없는 고아 슬롯만 비우고 probe-ready half-open으로 되돌려 다음 canExecute() 호출
   * 하나만 새 프로브를 시도할 수 있게 하는 사후 안전망이다.
   */
  private recoverIfExpired(agentId: string): CircuitSnapshot {
    const current = this.ensure(agentId);
    const hasLiveProbe = Array.from(this.halfOpenProbeSignals.get(agentId) ?? [])
      .some(signal => !signal.aborted);
    const cooldownExpired = current.state === 'open'
      && current.reason !== 'auth'
      && current.cooldownUntil != null
      && Date.now() >= current.cooldownUntil;
    const abandonedProbe = current.state === 'half-open'
      && current.openedAt != null
      && Date.now() - current.openedAt > HALF_OPEN_TTL_MS
      && !hasLiveProbe;

    if (cooldownExpired || abandonedProbe) {
      this.halfOpenAttempts.delete(agentId);
      this.halfOpenProbeSignals.delete(agentId);
      const next: CircuitSnapshot = {
        ...current,
        state: 'half-open',
        failureCount: 0,
        openedAt: Date.now(),
      };
      this.commit(
        next,
        cooldownExpired
          ? 'Circuit became probe-ready after cooldown expiry'
          : 'Circuit reclaimed abandoned half-open probe slot',
      );
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

  /**
   * 모든 회로를 스캔하여 만료된 cooldown/open 회로와 5분 초과 고아 half-open
   * 회로를 probe-ready half-open으로 전환한다. recovered는 닫힘이 아니라 단일
   * 복구 프로브를 받을 준비가 끝난 회로 수다.
   */
  recoverAll(): { recovered: number; open: number; total: number } {
    const agentIds = Array.from(this.states.keys());
    let recovered = 0;
    let open = 0;
    for (const agentId of agentIds) {
      const before = this.states.get(agentId);
      const after = this.getSnapshot(agentId);
      if (before && before.state === 'open' && after.state === 'half-open') recovered++;
      if (
        before
        && before.state === 'half-open'
        && after.state === 'half-open'
        && before.openedAt !== after.openedAt
      ) recovered++;
      if (after.state === 'open') open++;
    }
    return { recovered, open, total: agentIds.length };
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

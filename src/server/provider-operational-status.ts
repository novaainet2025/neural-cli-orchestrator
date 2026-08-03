import type { ProviderAvailabilitySnapshot } from '../security/circuit-breaker-registry.js';

export const PROVIDER_WORK_FRESHNESS_MS = 3 * 60_000;

export interface ProviderLiveTaskEvidence {
  id: string;
  prompt: string | null;
  status: 'running' | 'streaming' | string;
  observedAt?: string | null;
}

export interface ProviderPushEvidence {
  status: string;
  currentTask: string | null;
  taskId?: string;
  since?: string;
  reportedAt: string;
}

export interface ProviderSessionEvidence {
  status: string;
  currentTask: string | null;
  observedAt: string | null;
  ageMs: number;
  source: string;
}

export interface ProviderWorkStatus {
  status: 'working' | 'idle' | 'unknown';
  active: boolean | null;
  evidence: 'lease-backed-task' | 'fresh-fleet-report' | 'fresh-session-status'
    | 'no-live-execution' | 'stale-working-signal';
  freshness: 'fresh' | 'stale';
  observedAt: string;
  taskId: string | null;
  currentTask: string | null;
  since: string | null;
}

export interface DurableRateLimitEvidence {
  resetAt: string;
  reason: string | null;
  updatedAt: string | null;
}

export interface ProviderLimitStatus {
  status: 'available' | 'limited' | 'probing' | 'blocked' | 'inconsistent';
  limited: boolean | null;
  availableForNewWork: boolean;
  reason: string | null;
  retryAt: string | null;
  evidence: 'routing-admission' | 'durable-rate-limit' | 'inconsistent-expired-gate';
  observedAt: string;
  staleRecord: boolean;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFreshTimestamp(value: string | null | undefined, nowMs: number): boolean {
  const parsed = parseTimestamp(value);
  return parsed !== null && parsed <= nowMs && nowMs - parsed <= PROVIDER_WORK_FRESHNESS_MS;
}

export function resolveProviderWorkStatus(input: {
  liveTask?: ProviderLiveTaskEvidence | null;
  pushed?: ProviderPushEvidence | null;
  session?: ProviderSessionEvidence | null;
  sharedStatus?: string | null;
  nowMs?: number;
}): ProviderWorkStatus {
  const nowMs = input.nowMs ?? Date.now();
  const observedAt = new Date(nowMs).toISOString();

  if (input.liveTask) {
    return {
      status: 'working',
      active: true,
      evidence: 'lease-backed-task',
      freshness: 'fresh',
      observedAt,
      taskId: input.liveTask.id,
      currentTask: input.liveTask.prompt?.slice(0, 80) ?? input.liveTask.id,
      since: input.liveTask.observedAt ?? null,
    };
  }

  const pushedWorking = input.pushed?.status === 'working';
  if (pushedWorking && isFreshTimestamp(input.pushed?.reportedAt, nowMs)) {
    return {
      status: 'working',
      active: true,
      evidence: 'fresh-fleet-report',
      freshness: 'fresh',
      observedAt: input.pushed!.reportedAt,
      taskId: input.pushed!.taskId ?? null,
      currentTask: input.pushed!.currentTask,
      since: input.pushed!.since ?? null,
    };
  }

  const trustedSessionWorking = input.session?.source === 'explicit-status'
    || input.session?.source === 'question-active'
    || input.session?.source.startsWith('frequency:') === true;
  if (
    input.session?.status === 'working'
    && trustedSessionWorking
    && Number.isFinite(input.session.ageMs)
    && input.session.ageMs >= 0
    && input.session.ageMs <= PROVIDER_WORK_FRESHNESS_MS
  ) {
    return {
      status: 'working',
      active: true,
      evidence: 'fresh-session-status',
      freshness: 'fresh',
      observedAt: input.session.observedAt ?? observedAt,
      taskId: null,
      currentTask: input.session.currentTask,
      since: input.session.observedAt,
    };
  }

  const staleWorkingSignal = pushedWorking
    || (input.session?.status === 'working' && trustedSessionWorking)
    || input.sharedStatus === 'working';
  if (staleWorkingSignal) {
    return {
      status: 'unknown',
      active: null,
      evidence: 'stale-working-signal',
      freshness: 'stale',
      observedAt,
      taskId: null,
      currentTask: null,
      since: null,
    };
  }

  return {
    status: 'idle',
    active: false,
    evidence: 'no-live-execution',
    freshness: 'fresh',
    observedAt,
    taskId: null,
    currentTask: null,
    since: null,
  };
}

export function resolveProviderLimitStatus(input: {
  availability: ProviderAvailabilitySnapshot;
  durableRateLimit?: DurableRateLimitEvidence | null;
  staleRecord?: boolean;
  nowMs?: number;
}): ProviderLimitStatus {
  const nowMs = input.nowMs ?? Date.now();
  const observedAt = new Date(nowMs).toISOString();
  const staleRecord = input.staleRecord === true;

  if (input.durableRateLimit) {
    return {
      status: 'limited',
      limited: true,
      availableForNewWork: false,
      reason: input.durableRateLimit.reason ?? 'rate-limit',
      retryAt: input.durableRateLimit.resetAt,
      evidence: 'durable-rate-limit',
      observedAt,
      staleRecord,
    };
  }

  const gate = input.availability;
  const retryAtMs = parseTimestamp(gate.cooldownUntil);
  if (
    gate.status !== 'available'
    && gate.status !== 'probe'
    && retryAtMs !== null
    && retryAtMs <= nowMs
  ) {
    return {
      status: 'inconsistent',
      limited: null,
      availableForNewWork: false,
      reason: gate.reason,
      retryAt: gate.cooldownUntil,
      evidence: 'inconsistent-expired-gate',
      observedAt,
      staleRecord: true,
    };
  }

  if (gate.status === 'probe') {
    return {
      status: 'probing',
      limited: false,
      availableForNewWork: false,
      reason: gate.reason,
      retryAt: gate.cooldownUntil,
      evidence: 'routing-admission',
      observedAt,
      staleRecord,
    };
  }

  if (gate.status === 'gated:quota' || gate.status === 'gated:rate-limit') {
    return {
      status: 'limited',
      limited: true,
      availableForNewWork: false,
      reason: gate.reason ?? (gate.status === 'gated:quota' ? 'quota' : 'rate-limit'),
      retryAt: gate.cooldownUntil,
      evidence: 'routing-admission',
      observedAt,
      staleRecord,
    };
  }

  if (gate.status !== 'available') {
    return {
      status: 'blocked',
      limited: false,
      availableForNewWork: false,
      reason: gate.reason,
      retryAt: gate.cooldownUntil,
      evidence: 'routing-admission',
      observedAt,
      staleRecord,
    };
  }

  return {
    status: 'available',
    limited: false,
    availableForNewWork: true,
    reason: null,
    retryAt: null,
    evidence: 'routing-admission',
    observedAt,
    staleRecord,
  };
}

export function providerOperationalGuidance(
  work: ProviderWorkStatus,
  limit: ProviderLimitStatus,
): string {
  if (work.status === 'working' && !limit.availableForNewWork) {
    return `기존 작업은 진행 중이지만 신규 작업 배정은 불가합니다 (${limit.status}${limit.reason ? `: ${limit.reason}` : ''}).`;
  }
  if (work.status === 'working') return '현재 작업 중이며 추가 배정 전 큐 여유를 확인하세요.';
  if (limit.status === 'limited') {
    return limit.retryAt
      ? `리밋 적용 중입니다. ${limit.retryAt} 이후 다시 확인하세요.`
      : '리밋 적용 중이며 자동 해제 시각이 없습니다. 계정 사용량을 확인하세요.';
  }
  if (limit.status === 'probing') return '쿨다운은 끝났지만 실제 추론 성공 확인 전까지 새 작업을 보류하세요.';
  if (limit.status === 'blocked') {
    return limit.reason === 'auth'
      ? '인증 오류로 차단되었습니다. 자격 증명을 갱신한 뒤 재검증하세요.'
      : '프로바이더 오류로 차단되었습니다. 마지막 오류와 헬스 프로브를 확인하세요.';
  }
  if (limit.status === 'inconsistent') return '표시 상태가 만료 시각과 모순됩니다. 게이트를 갱신하고 실제 추론을 재검증하세요.';
  if (work.status === 'unknown') return '최근 작업 신호가 오래되어 작업 여부를 확정할 수 없습니다.';
  if (limit.staleRecord) return '만료된 과거 리밋 기록이 남아 있지만 현재 리밋은 아니며 새 작업 배정이 가능합니다.';
  return '현재 활성 작업 근거가 없고 새 작업 배정이 가능합니다.';
}

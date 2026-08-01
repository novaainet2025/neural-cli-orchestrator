/**
 * Provider readiness is deliberately stricter than provider health.
 *
 * Registration, runtime loading, heartbeat, admission, queue capacity and a
 * recent successful inference are independent facts. Collapsing them into a
 * single "healthy" flag made NCO accept work that could not actually run.
 */
export type ReadinessStatus = 'ready' | 'not-ready' | 'unknown';

export type ProviderReadinessDimension =
  | 'registration'
  | 'runtimeLoaded'
  | 'heartbeat'
  | 'admission'
  | 'queueCapacity'
  | 'inferenceEvidence';

export interface ReadinessDimensionResult {
  status: ReadinessStatus;
  ready: boolean;
  basis: string;
  reason: string;
  observedAt?: string;
}

export interface ProviderReadinessInput {
  providerId: string;
  registration: { registered: boolean | null };
  runtimeLoaded: { loaded: boolean | null };
  heartbeat: { alive: boolean | null; observedAt?: string | null };
  admission: { available: boolean | null; reason?: string | null };
  queueCapacity: {
    available: boolean | null;
    active?: number;
    concurrency?: number;
  };
  inferenceEvidence?: { success: boolean; observedAt: string } | null;
}

export interface ProviderReadinessOptions {
  now?: Date;
  inferenceEvidenceMaxAgeMs?: number;
}

export interface ProviderReadinessResult {
  providerId: string;
  generatedAt: string;
  readyForNewWork: boolean;
  /** Actual inference proof is observational and must not deadlock the first post-restart task. */
  inferenceVerified: boolean;
  blockers: ProviderReadinessDimension[];
  verificationBlockers: ProviderReadinessDimension[];
  dimensions: Record<ProviderReadinessDimension, ReadinessDimensionResult>;
}

const DEFAULT_INFERENCE_EVIDENCE_MAX_AGE_MS = 5 * 60_000;
const FUTURE_CLOCK_SKEW_MS = 5_000;

function booleanDimension(
  value: boolean | null,
  basis: string,
  falseReason: string,
): ReadinessDimensionResult {
  if (value === null) {
    return { status: 'unknown', ready: false, basis, reason: `${basis}-unknown` };
  }
  if (!value) {
    return { status: 'not-ready', ready: false, basis, reason: falseReason };
  }
  return { status: 'ready', ready: true, basis, reason: 'ready' };
}

function inferenceDimension(
  evidence: ProviderReadinessInput['inferenceEvidence'],
  nowMs: number,
  maxAgeMs: number,
): ReadinessDimensionResult {
  const basis = 'successful-inference-receipt';
  if (!evidence) {
    return { status: 'not-ready', ready: false, basis, reason: 'inference-evidence-missing' };
  }
  if (!evidence.success) {
    return {
      status: 'not-ready',
      ready: false,
      basis,
      reason: 'last-inference-failed',
      observedAt: evidence.observedAt,
    };
  }

  const observedAtMs = Date.parse(evidence.observedAt);
  if (!Number.isFinite(observedAtMs)) {
    return { status: 'not-ready', ready: false, basis, reason: 'inference-evidence-invalid' };
  }
  if (observedAtMs > nowMs + FUTURE_CLOCK_SKEW_MS) {
    return {
      status: 'not-ready',
      ready: false,
      basis,
      reason: 'inference-evidence-in-future',
      observedAt: evidence.observedAt,
    };
  }
  if (nowMs - observedAtMs > maxAgeMs) {
    return {
      status: 'not-ready',
      ready: false,
      basis,
      reason: 'inference-evidence-stale',
      observedAt: evidence.observedAt,
    };
  }
  return {
    status: 'ready',
    ready: true,
    basis,
    reason: 'ready',
    observedAt: evidence.observedAt,
  };
}

function queueCapacityDimension(
  input: ProviderReadinessInput['queueCapacity'],
): ReadinessDimensionResult {
  const result = booleanDimension(input.available, 'queue-capacity', 'queue-capacity-unavailable');
  if (!result.ready) return result;

  if (input.concurrency !== undefined && input.concurrency <= 0) {
    return {
      status: 'not-ready',
      ready: false,
      basis: 'queue-capacity',
      reason: 'queue-concurrency-invalid',
    };
  }
  if (
    input.active !== undefined
    && input.concurrency !== undefined
    && input.active >= input.concurrency
  ) {
    return {
      status: 'not-ready',
      ready: false,
      basis: 'queue-capacity',
      reason: 'queue-capacity-exhausted',
    };
  }
  return result;
}

/** Build a fail-closed, data-only admission view for one provider. */
export function evaluateProviderReadiness(
  input: ProviderReadinessInput,
  options: ProviderReadinessOptions = {},
): ProviderReadinessResult {
  const now = options.now ?? new Date();
  const configuredMaxAge = options.inferenceEvidenceMaxAgeMs
    ?? DEFAULT_INFERENCE_EVIDENCE_MAX_AGE_MS;
  const maxAgeMs = Number.isFinite(configuredMaxAge) && configuredMaxAge >= 0
    ? configuredMaxAge
    : DEFAULT_INFERENCE_EVIDENCE_MAX_AGE_MS;

  const dimensions: ProviderReadinessResult['dimensions'] = {
    registration: booleanDimension(
      input.registration.registered,
      'provider-registry',
      'provider-not-registered',
    ),
    runtimeLoaded: booleanDimension(
      input.runtimeLoaded.loaded,
      'runtime-generation',
      'provider-runtime-not-loaded',
    ),
    heartbeat: {
      ...booleanDimension(input.heartbeat.alive, 'provider-heartbeat', 'provider-heartbeat-dead'),
      ...(input.heartbeat.observedAt ? { observedAt: input.heartbeat.observedAt } : {}),
    },
    admission: booleanDimension(
      input.admission.available,
      'circuit-breaker-admission',
      input.admission.reason || 'provider-admission-unavailable',
    ),
    queueCapacity: queueCapacityDimension(input.queueCapacity),
    inferenceEvidence: inferenceDimension(input.inferenceEvidence, now.getTime(), maxAgeMs),
  };
  const admissionDimensions: ProviderReadinessDimension[] = [
    'registration',
    'runtimeLoaded',
    'heartbeat',
    'admission',
    'queueCapacity',
  ];
  // A brand-new process has no inference receipt yet. Allow exactly that
  // bootstrap state to admit one real task, while keeping explicit failed,
  // malformed, future-dated or stale evidence fail-closed.
  if (
    !dimensions.inferenceEvidence.ready
    && dimensions.inferenceEvidence.reason !== 'inference-evidence-missing'
  ) {
    admissionDimensions.push('inferenceEvidence');
  }
  const blockers = admissionDimensions.filter(name => !dimensions[name].ready);
  const verificationBlockers = dimensions.inferenceEvidence.ready
    ? []
    : ['inferenceEvidence' as const];

  return {
    providerId: input.providerId,
    generatedAt: now.toISOString(),
    readyForNewWork: blockers.length === 0,
    inferenceVerified: dimensions.inferenceEvidence.ready,
    blockers,
    verificationBlockers,
    dimensions,
  };
}

/**
 * Blocking Evidence Bundle Gate (P1-6, ported from opencode-swarm).
 *
 * Context: `src/core/task-evidence.ts` only *warns* on empty/oversize evidence,
 * and `gateway.ts` performs a COALESCE-style partial update — there is no gate
 * that makes "no evidence => cannot complete" a hard block. This module supplies
 * that blocking gate.
 *
 * Self-contained: depends only on the Node/TS standard library. Deterministic —
 * no Date.now / Math.random usage.
 */

/** Result of an evidence check. */
export interface EvidenceGateResult {
  /** True only when every required kind is present and non-blank. */
  allowed: boolean;
  /** Required kinds that were absent or blank (deterministic order). */
  missing: string[];
}

/** Thrown by {@link assertPhaseComplete} when required evidence is missing. */
export class EvidenceGateError extends Error {
  /** The task whose phase completion was blocked. */
  readonly taskId: string;
  /** Required evidence kinds that were absent or blank. */
  readonly missing: string[];

  constructor(taskId: string, missing: string[]) {
    super(
      `phase_complete blocked for task "${taskId}": missing required evidence [${missing.join(', ')}]`,
    );
    this.name = 'EvidenceGateError';
    this.taskId = taskId;
    this.missing = missing;
    // Restore prototype chain for extending built-ins under ES2022 targets.
    Object.setPrototypeOf(this, EvidenceGateError.prototype);
  }
}

/**
 * Accepted shapes for evidence input: a JSON string, a parsed object, or
 * null/undefined. Anything unparseable or non-object is treated as empty
 * evidence (=> the gate blocks).
 */
export type EvidenceInput = string | Record<string, unknown> | null | undefined;

/**
 * Parse evidence into a flat key/value record.
 *
 * - JSON string => parsed; if the parse fails or the parsed value is not a
 *   plain object (array, number, null, ...), returns `{}` (empty evidence).
 * - Object => used as-is.
 * - null / undefined => `{}`.
 */
export function parseEvidence(evidence: EvidenceInput): Record<string, unknown> {
  if (evidence == null) {
    return {};
  }

  if (typeof evidence === 'string') {
    const trimmed = evidence.trim();
    if (trimmed === '') {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Malformed JSON is treated as empty evidence => gate blocks.
      return {};
    }
    return isPlainRecord(parsed) ? parsed : {};
  }

  // Already an object (but guard against arrays / null slipping through types).
  return isPlainRecord(evidence) ? evidence : {};
}

/**
 * Check whether all `requiredKinds` are present and non-blank in `evidence`.
 *
 * A kind is considered *present* when its key exists and its value is neither
 * null/undefined, an empty/whitespace-only string, nor an empty array.
 */
export function requireEvidence(
  evidence: EvidenceInput,
  requiredKinds: readonly string[],
): EvidenceGateResult {
  const record = parseEvidence(evidence);
  const kinds = normalizeKinds(requiredKinds);

  const missing: string[] = [];
  for (const kind of kinds) {
    if (!hasEvidence(record[kind])) {
      missing.push(kind);
    }
  }

  return { allowed: missing.length === 0, missing };
}

/**
 * Assert that a task's phase can complete. Throws {@link EvidenceGateError}
 * (with the missing kinds) when any required evidence is absent or blank.
 * This is the actual "phase_complete block".
 */
export function assertPhaseComplete(
  taskId: string,
  evidence: EvidenceInput,
  requiredKinds: readonly string[],
): void {
  const { allowed, missing } = requireEvidence(evidence, requiredKinds);
  if (!allowed) {
    throw new EvidenceGateError(taskId, missing);
  }
}

// --- internals -------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Trim, drop blanks, and de-duplicate required kinds while preserving order. */
function normalizeKinds(requiredKinds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of requiredKinds) {
    const kind = typeof raw === 'string' ? raw.trim() : '';
    if (kind === '' || seen.has(kind)) {
      continue;
    }
    seen.add(kind);
    result.push(kind);
  }
  return result;
}

/** A value counts as evidence when it is non-null and not blank/empty. */
function hasEvidence(value: unknown): boolean {
  if (value == null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim() !== '';
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  // Numbers, booleans, non-empty objects, etc. count as present evidence.
  return true;
}

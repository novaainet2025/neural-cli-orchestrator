import { z } from 'zod/v4';

/**
 * Delegation payload validation (intake-time agent enum enforcement).
 *
 * Background: `validation.ts` (CreateTaskInput) hard-codes the `ai` enum, so a
 * delegation whose target agent is not part of that literal set is accepted as
 * `queued` and only fails much later at runtime ("Unknown agent"). This module
 * blocks such payloads at *intake* by validating `ai` against the set of agent
 * ids that are actually known at call time (e.g. the live provider registry),
 * producing a clear, deterministic rejection instead of a delayed runtime fault.
 *
 * Self-contained: mirrors the shape of CreateTaskInput (mode/prompt/ai/…) but
 * does not import from validation.ts, so it cannot break existing schemas.
 */

// Coordination modes — kept in sync with TaskModeSchema in validation.ts.
export const DelegationModeSchema = z.enum([
  'task', 'parallel', 'discussion', 'realtime',
  'consensus', 'hive', 'broadcast', 'agent',
]);

export type DelegationMode = z.infer<typeof DelegationModeSchema>;

/**
 * Build a zod schema for a delegation payload whose `ai` field must be one of
 * `knownAgentIds`. Enforcing the enum at schema-build time (rather than a fixed
 * literal union) lets the caller pass the current provider registry so unknown
 * agents are rejected *before* the task is queued.
 *
 * @param knownAgentIds Agent ids accepted as delegation targets. Must be non-empty.
 * @throws {Error} if `knownAgentIds` is empty (a schema that accepts nothing is a bug).
 */
export function makeDelegationPayloadSchema(knownAgentIds: readonly string[]) {
  if (knownAgentIds.length === 0) {
    throw new Error('makeDelegationPayloadSchema: knownAgentIds must be non-empty');
  }
  // Deterministic ordering for the error message; de-duplicated for a clean list.
  const known = new Set(knownAgentIds);
  const knownList = [...known].join(', ');

  return z.object({
    ai: z
      .string({ message: 'ai is required' })
      .min(1, 'ai is required')
      .refine((value) => known.has(value), {
        error: (issue) =>
          `Unknown agent '${String(issue.input)}'. Known: ${knownList}`,
      }),
    prompt: z.string().min(1),
    mode: DelegationModeSchema.optional().default('task'),
    providers: z.array(z.string()).optional(),
    workspaceId: z.string().optional().default('default'),
    priority: z.number().int().min(0).max(10).optional().default(0),
    timeout: z.number().int().min(1000).max(1_800_000).optional(),
    systemPrompt: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });
}

export type DelegationPayloadSchema = ReturnType<typeof makeDelegationPayloadSchema>;

/** Parsed delegation payload (defaults applied for mode/workspaceId/priority). */
export type DelegationPayload = z.infer<DelegationPayloadSchema>;

export interface DelegationValidationSuccess {
  ok: true;
  data: DelegationPayload;
}

export interface DelegationValidationFailure {
  ok: false;
  error: string;
}

export type DelegationValidationResult =
  | DelegationValidationSuccess
  | DelegationValidationFailure;

/**
 * Validate a delegation payload *before* accepting it into the queue.
 *
 * Returns a discriminated result rather than throwing so the caller can reject
 * the intake request cleanly. When the `ai` field is not one of `knownAgentIds`
 * the result is `{ ok: false }` with a message naming the unknown agent and the
 * known set — the delegation is blocked at intake instead of failing at runtime.
 */
export function validateDelegationPayload(
  input: unknown,
  knownAgentIds: readonly string[],
): DelegationValidationResult {
  const schema = makeDelegationPayloadSchema(knownAgentIds);
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  const error = parsed.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
  return { ok: false, error };
}

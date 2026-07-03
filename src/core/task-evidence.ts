import { z } from 'zod/v4';

const MAX_EVIDENCE_JSON_BYTES = 64 * 1024;

const EvidenceItemSchema = z.object({
  claim: z.string().min(1),
  tier: z.enum(['T1', 'T2', 'T3', 'T4']),
  method: z.string().min(1),
  raw: z.string().min(1).optional(),
});

const EvidenceArraySchema = z.array(EvidenceItemSchema).min(1);

const EVIDENCE_BLOCK_PATTERNS = [
  /```evidence\s*([\s\S]*?)```/i,
  /evidence:\s*```(?:json)?\s*([\s\S]*?)```/i,
  /<evidence>\s*([\s\S]*?)\s*<\/evidence>/i,
];

type EvidenceExtractionResult = {
  evidenceJson?: string;
  warning?: string;
};

function normalizeEvidencePayload(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === 'object' && Array.isArray((payload as { evidence?: unknown }).evidence)) {
    return (payload as { evidence: unknown[] }).evidence;
  }
  return undefined;
}

export function extractTaskEvidenceJson(output: string): EvidenceExtractionResult {
  for (const pattern of EVIDENCE_BLOCK_PATTERNS) {
    const match = output.match(pattern);
    if (!match) continue;

    const block = match[1]?.trim() ?? '';
    if (!block) {
      return { warning: 'empty evidence block' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch (err) {
      return {
        warning: `invalid evidence JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const normalized = normalizeEvidencePayload(parsed);
    const validated = EvidenceArraySchema.safeParse(normalized);
    if (!validated.success) {
      return {
        warning: `invalid evidence schema: ${validated.error.issues.map(issue => issue.message).join('; ')}`,
      };
    }

    const evidenceJson = JSON.stringify(validated.data);
    if (Buffer.byteLength(evidenceJson, 'utf8') > MAX_EVIDENCE_JSON_BYTES) {
      return { warning: `evidence_json exceeds ${MAX_EVIDENCE_JSON_BYTES} bytes` };
    }

    return { evidenceJson };
  }

  return {};
}

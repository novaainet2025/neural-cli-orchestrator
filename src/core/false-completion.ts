export interface PromptGateMetadata {
  score?: number;
  enriched?: boolean;
  missing?: string[];
}

export function readPromptGateMetadata(
  metadata: Record<string, unknown> | undefined,
): PromptGateMetadata | undefined {
  const promptGate = metadata?.promptGate;
  if (!promptGate || typeof promptGate !== 'object' || Array.isArray(promptGate)) {
    return undefined;
  }
  return promptGate as PromptGateMetadata;
}

// completed이지만 intake 시 prompt gate가 score=0이고 enrichment도 없었던 경우.
// enriched=true이면 사전 점수는 0이어도 자동 보강 후 실행된 정상 완료다.
export function isFalseCompletion(
  metadata: Record<string, unknown> | undefined,
  status: string,
): boolean {
  if (status !== 'completed') return false;
  const promptGate = readPromptGateMetadata(metadata);
  if (!promptGate || promptGate.score !== 0) return false;
  return promptGate.enriched !== true;
}

const FALSE_COMPLETION_EXCLUSION_DISABLED = new Set(['0', 'false', 'off']);

const FALSE_COMPLETION_EXCLUSION_SQL = `AND NOT (
      k.status = 'completed'
      AND json_valid(k.metadata_json)
      AND COALESCE(json_extract(k.metadata_json, '$.promptGate.score'), -1) = 0
      AND COALESCE(json_extract(k.metadata_json, '$.promptGate.enriched'), '') NOT IN (1, '1', 'true', 'TRUE')
    )`;

export function buildFalseCompletionExclusion(
  toggle: string | undefined = process.env.NCO_SCORER_FALSE_COMPLETION_EXCLUSION,
): string {
  return FALSE_COMPLETION_EXCLUSION_DISABLED.has(toggle?.trim().toLowerCase() ?? '')
    ? ''
    : FALSE_COMPLETION_EXCLUSION_SQL;
}

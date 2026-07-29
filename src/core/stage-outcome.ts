export interface BlockedStageOutcome {
  kind: 'blocked';
  fingerprint: string;
  evidence: string;
  evidenceTier: 1;
}

const PLACEHOLDER_EVIDENCE = /^(?:none|n\/a|unknown|unverified|없음|미검증)$/i;

function fieldValue(response: string, field: string): string | undefined {
  const match = response.match(new RegExp(`^\\s*${field}\\s*:\\s*(.+?)\\s*$`, 'im'));
  return match?.[1]?.trim();
}

/**
 * Parse the fail-closed company-stage BLOCKED protocol.
 *
 * A natural-language "BLOCKED" remains an ordinary failure. The exceptional
 * terminal outcome requires a collaboration status/error prefix plus every
 * structured field below, including direct Tier 1 evidence.
 */
export function parseBlockedStageOutcome(
  response: string | null | undefined,
): BlockedStageOutcome | undefined {
  if (!response || !/^\s*(?:status|error)\s*:/i.test(response)) return undefined;
  if (fieldValue(response, 'STAGE_OUTCOME')?.toUpperCase() !== 'BLOCKED') return undefined;

  const rawFingerprint = fieldValue(response, 'BLOCKER_FINGERPRINT');
  const evidence = fieldValue(response, 'BLOCKER_EVIDENCE');
  const tier = fieldValue(response, 'EVIDENCE_TIER');
  if (!rawFingerprint || !evidence || tier !== '1') return undefined;

  const fingerprint = rawFingerprint.toLowerCase().replace(/\s+/g, ' ').trim();
  if (fingerprint.length < 8 || fingerprint.length > 240) return undefined;
  if (evidence.length < 8 || evidence.length > 2_000 || PLACEHOLDER_EVIDENCE.test(evidence)) {
    return undefined;
  }

  return {
    kind: 'blocked',
    fingerprint,
    evidence,
    evidenceTier: 1,
  };
}

export const BLOCKED_STAGE_OUTCOME_CONTRACT = [
  `[구조화 단계 결과 계약]`,
  `검증된 선행조건 부재로 안전하게 진행할 수 없을 때만 아래 네 필드를 그대로 포함하세요.`,
  `응답 첫 줄은 status: 또는 error: 협업 프로토콜이어야 합니다.`,
  `STAGE_OUTCOME: BLOCKED`,
  `BLOCKER_FINGERPRINT: <같은 원인에 재사용할 안정적인 식별자>`,
  `BLOCKER_EVIDENCE: <직접 확인한 파일/DB/HTTP 근거와 관측값>`,
  `EVIDENCE_TIER: 1`,
  `네 필드 중 하나라도 없거나 근거가 미검증이면 일반 실패로 처리되어 기존 재시도 동작을 유지합니다.`,
].join('\n');

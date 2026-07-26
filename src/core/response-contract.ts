export const SOURCE_DISCOVERY_RESPONSE_CONTRACT = '[01 Source Discovery 응답 계약]';
export const IMPROVEMENT_DEBATE_RESPONSE_CONTRACT = '[06 Improvement Debate 응답 계약]';
export const SELF_IMPROVEMENT_DIAGNOSTIC_RESPONSE_CONTRACT = '[Self-Improvement Diagnostic 응답·증거 계약]';
export const RESEARCH_STRATEGY_RESPONSE_CONTRACT = '[Research Strategy 응답 계약]';
export const QUALITY_AUDIT_RESPONSE_CONTRACT = '[Quality Audit 응답 계약]';
export const UPGRADE_REGRESSION_RESPONSE_CONTRACT = '[05 Upgrade Regression 응답 계약]';

export const RESPONSE_CONTRACT_MARKERS = [
  SOURCE_DISCOVERY_RESPONSE_CONTRACT,
  IMPROVEMENT_DEBATE_RESPONSE_CONTRACT,
  SELF_IMPROVEMENT_DIAGNOSTIC_RESPONSE_CONTRACT,
  RESEARCH_STRATEGY_RESPONSE_CONTRACT,
  QUALITY_AUDIT_RESPONSE_CONTRACT,
  UPGRADE_REGRESSION_RESPONSE_CONTRACT,
] as const;

export function hasResponseContract(prompt: string | null | undefined): boolean {
  if (!prompt) return false;
  return RESPONSE_CONTRACT_MARKERS.some((marker) => prompt.includes(marker));
}

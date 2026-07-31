import { describe, expect, it } from 'vitest';
import {
  GOV_COMMAND_INTAKE_RESPONSE_CONTRACT,
  hasResponseContract,
  IMPROVEMENT_DEBATE_RESPONSE_CONTRACT,
  QUALITY_AUDIT_RESPONSE_CONTRACT,
  RESEARCH_STRATEGY_RESPONSE_CONTRACT,
  RESILIENCE_REVIEW_RESPONSE_CONTRACT,
  SELF_IMPROVEMENT_DIAGNOSTIC_RESPONSE_CONTRACT,
  SOURCE_DISCOVERY_RESPONSE_CONTRACT,
} from './response-contract.js';

describe('hasResponseContract', () => {
  it.each([
    SOURCE_DISCOVERY_RESPONSE_CONTRACT,
    IMPROVEMENT_DEBATE_RESPONSE_CONTRACT,
    SELF_IMPROVEMENT_DIAGNOSTIC_RESPONSE_CONTRACT,
    RESEARCH_STRATEGY_RESPONSE_CONTRACT,
    QUALITY_AUDIT_RESPONSE_CONTRACT,
    GOV_COMMAND_INTAKE_RESPONSE_CONTRACT,
    RESILIENCE_REVIEW_RESPONSE_CONTRACT,
  ])('recognizes an explicitly disclosed protocol marker: %s', marker => {
    expect(hasResponseContract(`[목표] 작업 수행\n${marker}`)).toBe(true);
  });

  it('does not infer a protocol contract from verifier presence or generic text', () => {
    expect(hasResponseContract('[검증기준] npx tsc --noEmit')).toBe(false);
    expect(hasResponseContract('done 결과를 알려주세요')).toBe(false);
    expect(hasResponseContract(null)).toBe(false);
  });
});

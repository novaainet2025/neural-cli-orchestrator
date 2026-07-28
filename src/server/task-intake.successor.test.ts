import { describe, expect, it } from 'vitest';
import {
  applyPromptGate,
  buildDefaultVerifierWithFs,
  hasResponseContract,
} from './task-intake.js';

const IMPROVEMENT_DEBATE_MARKER = '[06 Improvement Debate 응답 계약]';
const RESEARCH_STRATEGY_MARKER = '[Research Strategy 응답 계약]';
const QUALITY_AUDIT_MARKER = '[Quality Audit 응답 계약]';

describe('successor team ID regression', () => {

  it('team_tech-port-06-decision-2026 inherits improvement-debate contract', () => {
    const r = applyPromptGate('[목표] 개선 방향을 토론한다', {
      projectDir: '/repo',
      teamId: 'team_tech-port-06-decision-2026',
    });
    expect(r.prompt).toContain(IMPROVEMENT_DEBATE_MARKER);
    expect(hasResponseContract(r.prompt)).toBe(true);
  });

  it('team_research-strategy-2026 inherits research-strategy contract and skips build verifier on company runs', () => {
    const metadata = {
      projectDir: '/repo',
      teamId: 'team_research-strategy-2026',
      companyRunId: 'corun_research_2026',
    };
    const r = applyPromptGate('[목표] 연구질문과 성공기준을 설계한다', metadata);
    expect(r.prompt).toContain(RESEARCH_STRATEGY_MARKER);
    expect(hasResponseContract(r.prompt)).toBe(true);
    expect(buildDefaultVerifierWithFs({
      prompt: r.prompt,
      metadata,
      verifier: undefined,
    }, () => true)).toBeUndefined();
  });

  it('team_content-quality inherits quality-audit contract as successor', () => {
    const r = applyPromptGate('[목표] 코드 품질을 감사한다', {
      projectDir: '/repo',
      teamId: 'team_content-quality',
    });
    expect(r.prompt).toContain(QUALITY_AUDIT_MARKER);
    expect(hasResponseContract(r.prompt)).toBe(true);
  });

  it('old teams still receive the same contract (non-regression)', () => {
    const oldImp = applyPromptGate('[목표] 개선 방향을 토론한다', {
      projectDir: '/repo',
      teamId: 'team_tech-port-06-improvement-debate',
    });
    const oldRs = applyPromptGate('[목표] 연구질문과 성공기준을 설계한다', {
      projectDir: '/repo',
      teamId: 'team_research-strategy',
      companyRunId: 'corun_old',
    });
    const oldQa = applyPromptGate('[목표] 코드 품질을 감사한다', {
      projectDir: '/repo',
      teamId: 'team_quality-audit',
    });
    expect(oldImp.prompt).toContain(IMPROVEMENT_DEBATE_MARKER);
    expect(oldRs.prompt).toContain(RESEARCH_STRATEGY_MARKER);
    expect(oldQa.prompt).toContain(QUALITY_AUDIT_MARKER);
  });
});

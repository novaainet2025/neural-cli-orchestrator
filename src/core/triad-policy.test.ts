import { describe, expect, it } from 'vitest';
import {
  buildTriadPlan,
  certifyEfficiency,
  certifyEfficiencyRuns,
  loadTriadPolicy,
  shouldInvokeAgy,
} from './triad-policy.js';

describe('triad policy', () => {
  it('loads the safe asymmetric concurrency contract', () => {
    const policy = loadTriadPolicy();
    expect(policy.flow).toEqual(['plan', 'build', 'challenge', 'fix', 'prove', 'approve']);
    expect(policy.parallelism['claude-code']).toBe(1);
    expect(policy.parallelism.codex).toBe(2);
    expect(policy.parallelism.agy).toBe(1);
    expect(policy.loop.maxFixIterations).toBe(3);
    expect(policy.parallelism.isolation.lockTtlMs).toBeGreaterThan(policy.loop.runTimeoutMs);
  });

  it('invokes AGY for experience work and bypasses pure backend work', () => {
    expect(shouldInvokeAgy('React 화면의 loading/error state와 접근성을 개선', 'ui')).toBe(true);
    expect(shouldInvokeAgy('백엔드 SQLite 인덱스 추가', 'code')).toBe(false);
  });

  it('selects the experience profile only when user-facing evidence is material', () => {
    const ui = buildTriadPlan('프론트엔드 UI 접근성과 user flow를 구현');
    expect(ui.profile).toBe('experience');
    expect(ui.providers.experience).toBe(true);
    expect(ui.requiredEvidence).toContain('a11y');

    const backend = buildTriadPlan('백엔드 함수의 버그 수정');
    expect(backend.providers.experience).toBe(false);
    expect(backend.requiredEvidence).not.toContain('a11y');
  });

  it('never certifies 5x when quality or parallel-efficiency regresses', () => {
    const baseline = {
      verifiedCompletions: 10,
      wallClockHours: 10,
      falsePassRate: 0.02,
      postMergeDefectsPer100: 1,
      averageConcurrentWorkers: 1,
    };
    const candidate = {
      verifiedCompletions: 60,
      wallClockHours: 10,
      falsePassRate: 0.03,
      postMergeDefectsPer100: 1,
      averageConcurrentWorkers: 4,
    };
    const result = certifyEfficiency(baseline, candidate);
    expect(result.multiplier).toBe(6);
    expect(result.certified).toBe(false);
    expect(result.reasons).toContain('false-pass rate increased');
  });

  it('certifies a measured target only when all guardrails pass', () => {
    const baseline = {
      verifiedCompletions: 10,
      wallClockHours: 10,
      falsePassRate: 0.02,
      postMergeDefectsPer100: 1,
      averageConcurrentWorkers: 1,
    };
    const candidate = {
      verifiedCompletions: 50,
      wallClockHours: 2,
      falsePassRate: 0.01,
      postMergeDefectsPer100: 0.5,
      averageConcurrentWorkers: 3,
    };
    const result = certifyEfficiency(baseline, candidate);
    expect(result.multiplier).toBe(25);
    expect(result.parallelEfficiency).toBeCloseTo(5 / 3);
    expect(result.certified).toBe(true);
  });

  it('requires at least three paired receipts for a 5x certification', () => {
    const baseline = {
      verifiedCompletions: 1,
      wallClockHours: 1,
      falsePassRate: 0.02,
      postMergeDefectsPer100: 1,
      averageConcurrentWorkers: 1,
    };
    const candidate = {
      verifiedCompletions: 5,
      wallClockHours: 0.2,
      falsePassRate: 0.01,
      postMergeDefectsPer100: 0.5,
      averageConcurrentWorkers: 3,
    };
    const underSampled = certifyEfficiencyRuns([baseline, baseline], [candidate, candidate]);
    expect(underSampled.certified).toBe(false);
    expect(underSampled.reasons).toContain('at least 3 paired repeats are required');

    const repeated = certifyEfficiencyRuns(
      [baseline, baseline, baseline],
      [candidate, candidate, candidate],
    );
    expect(repeated.repeats).toBe(3);
    expect(repeated.certified).toBe(true);
  });
});

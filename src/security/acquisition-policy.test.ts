import { describe, expect, it } from 'vitest';
import { decideAcquisitionPolicy, type AcquisitionPolicy } from './acquisition-policy.js';

const policy: AcquisitionPolicy = {
  defaultPolicy: 'deny',
  ecosystems: ['npm'],
  scorecard: { rejectBelow: 3, approvalBelow: 5, failMode: 'closed' },
  licenses: { allow: ['MIT'], failMode: 'closed' },
  scripts: { defaultInstallMode: 'ignore', approvalOnPresence: true, rejectPatternsFrom: 'src/security/command-gate.ts', failMode: 'closed' },
  typosquat: { maxAutoDistance: 0, approvalDistance: 2, requirePopularityCheck: true, failMode: 'closed' },
  maintainers: { approvalOnChange: true, failMode: 'closed' },
  popularPackages: ['react'],
};

describe('decideAcquisitionPolicy', () => {
  it('returns auto_pass when all gates pass', () => {
    const result = decideAcquisitionPolicy({
      osv: { status: 'pass', evidence: '0 vulns', source: 'osv', failMode: 'closed' },
      scripts: { status: 'pass', evidence: 'none', source: 'npm', failMode: 'closed' },
    }, policy);

    expect(result.decision).toBe('auto_pass');
  });

  it('returns approval_required when any gate requires approval', () => {
    const result = decideAcquisitionPolicy({
      scorecard: { status: 'approval_required', evidence: 'score 4.2', source: 'deps.dev', failMode: 'closed' },
      scripts: { status: 'pass', evidence: 'none', source: 'npm', failMode: 'closed' },
    }, policy);

    expect(result.decision).toBe('approval_required');
  });

  it('returns hard_reject when any gate rejects', () => {
    const result = decideAcquisitionPolicy({
      osv: { status: 'reject', evidence: '1 vuln', source: 'osv', failMode: 'closed' },
      scripts: { status: 'pass', evidence: 'none', source: 'npm', failMode: 'closed' },
    }, policy);

    expect(result.decision).toBe('hard_reject');
  });
});

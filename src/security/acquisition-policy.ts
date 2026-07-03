import { readFileSync } from 'fs';
import { resolve } from 'path';
import { env } from '../utils/config.js';

export type AcquisitionDecision = 'auto_pass' | 'approval_required' | 'hard_reject';
export type AcquisitionGateStatus = 'pass' | 'approval_required' | 'reject';
export type AcquisitionFailMode = 'closed';

export interface AcquisitionGateResult {
  status: AcquisitionGateStatus;
  evidence: unknown;
  source: string;
  failMode: AcquisitionFailMode;
}

export interface AcquisitionPolicy {
  defaultPolicy: 'deny';
  ecosystems: string[];
  scorecard: {
    rejectBelow: number;
    approvalBelow: number;
    failMode: AcquisitionFailMode;
  };
  licenses: {
    allow: string[];
    failMode: AcquisitionFailMode;
  };
  scripts: {
    defaultInstallMode: 'ignore';
    approvalOnPresence: boolean;
    rejectPatternsFrom: string;
    failMode: AcquisitionFailMode;
  };
  typosquat: {
    maxAutoDistance: number;
    approvalDistance: number;
    requirePopularityCheck: boolean;
    failMode: AcquisitionFailMode;
  };
  maintainers: {
    approvalOnChange: boolean;
    failMode: AcquisitionFailMode;
  };
  popularPackages: string[];
}

export interface AcquisitionPolicyDecision {
  decision: AcquisitionDecision;
  reasons: string[];
}

export function loadAcquisitionPolicy(policyPath = resolve(env.ROOT, 'config/acquisition-policy.json')): AcquisitionPolicy {
  return JSON.parse(readFileSync(policyPath, 'utf-8')) as AcquisitionPolicy;
}

export function decideAcquisitionPolicy(
  gateResults: Record<string, AcquisitionGateResult>,
  policy: AcquisitionPolicy,
): AcquisitionPolicyDecision {
  const rejects = Object.entries(gateResults).filter(([, result]) => result.status === 'reject');
  if (rejects.length > 0) {
    return {
      decision: 'hard_reject',
      reasons: rejects.map(([gate, result]) => `${gate}: ${stringifyEvidence(result.evidence)}`),
    };
  }

  const approvals = Object.entries(gateResults).filter(([, result]) => result.status === 'approval_required');
  if (approvals.length > 0 || policy.defaultPolicy === 'deny') {
    if (approvals.length > 0) {
      return {
        decision: 'approval_required',
        reasons: approvals.map(([gate, result]) => `${gate}: ${stringifyEvidence(result.evidence)}`),
      };
    }
  }

  return {
    decision: 'auto_pass',
    reasons: Object.entries(gateResults).map(([gate, result]) => `${gate}: ${stringifyEvidence(result.evidence)}`),
  };
}

function stringifyEvidence(evidence: unknown): string {
  if (typeof evidence === 'string') return evidence;
  return JSON.stringify(evidence);
}

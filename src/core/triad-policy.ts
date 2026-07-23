import { loadJSON } from '../utils/config.js';
import type { TaskType } from './quality-gate.js';
import { smartRouter } from './smart-router.js';

export type TriadProfileName = 'fast' | 'standard' | 'experience' | 'ultra';
export type TriadRisk = 'low' | 'medium' | 'high';
export type TriadStageName = 'plan' | 'build' | 'challenge' | 'fix' | 'prove' | 'approve';

interface TriadProfile {
  commanderPlan: boolean;
  experienceChallenge: boolean;
  commanderApproval: boolean;
  maxPaidCalls: number;
}

export interface TriadPolicy {
  version: number;
  enabled: boolean;
  company: {
    id: string;
    slug: string;
    name: string;
    manager: string;
    parentId: string;
  };
  roles: Record<string, {
    title: string;
    responsibilities: string[];
    mayWrite: boolean;
    mayDelegate: boolean;
    mayApprove: boolean;
  }>;
  flow: TriadStageName[];
  profiles: Record<TriadProfileName, TriadProfile>;
  routing: {
    adaptiveScoring: boolean;
    operationalWindowDays: number;
    minimumOperationalSamples: number;
    experienceTaskTypes: string[];
    experiencePatterns: string[];
    highRiskPatterns: string[];
  };
  parallelism: {
    globalPaidCli: number;
    'claude-code': number;
    codex: number;
    agy: number;
    sameFilePolicy: 'queue';
    isolation: {
      mode: 'worktree-or-file-ownership';
      requireDeclaredFilesOnSharedTree: boolean;
      lockTtlMs: number;
      forbiddenSharedWritePatterns: string[];
    };
  };
  loop: {
    maxFixIterations: number;
    stageTimeoutMs: number;
    runTimeoutMs: number;
    challengeTimeoutMs: number;
    stopOnNoProgress: boolean;
    stopOnRegression: boolean;
    onChallengeUnavailable: 'blocked-human-escalation';
    onExhaustion: 'blocked-human-escalation';
  };
  evidence: {
    code: string[];
    experience: string[];
    naturalLanguageClaimsAccepted: boolean;
    independentVerifierRequired: boolean;
  };
  mesh: {
    enabled: boolean;
    sessionPrefix: string;
    participants: Record<string, string>;
    interSessionAliases: Record<string, string>;
    messageTypes: string[];
    maxContextCharsPerMessage: number;
  };
  kpi: {
    primaryMetric: string;
    targetMultiplier: number;
    minimumRepeats: number;
    minimumParallelEfficiency: number;
    qualityGuardrails: {
      falsePassRateMustNotIncrease: boolean;
      postMergeDefectsMustNotIncrease: boolean;
    };
    claimPolicy: 'measure-not-promise';
  };
}

export interface TriadPlan {
  profile: TriadProfileName;
  taskType: TaskType;
  complexity: number;
  risk: TriadRisk;
  providers: {
    commander: boolean;
    builder: true;
    experience: boolean;
    judge: boolean;
  };
  stages: Array<{ name: TriadStageName; active: boolean; owner: string }>;
  requiredEvidence: string[];
  maxFixIterations: number;
  maxPaidCalls: number;
}

export interface EfficiencySample {
  verifiedCompletions: number;
  wallClockHours: number;
  falsePassRate: number;
  postMergeDefectsPer100: number;
  averageConcurrentWorkers: number;
  serialWallClockHours?: number;
}

export interface EfficiencyCertification {
  multiplier: number | null;
  parallelEfficiency: number | null;
  certified: boolean;
  reasons: string[];
}

export interface EfficiencyBatchCertification extends EfficiencyCertification {
  repeats: number;
  baselineThroughputMedian: number | null;
  candidateThroughputMedian: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateTriadPolicy(value: unknown): TriadPolicy {
  if (!isRecord(value) || value.version !== 1 || value.enabled !== true) {
    throw new Error('[triad-policy] version=1 and enabled=true are required');
  }
  if (!isRecord(value.profiles) || !isRecord(value.loop) || !isRecord(value.parallelism)) {
    throw new Error('[triad-policy] profiles, loop, and parallelism are required');
  }
  const flow = value.flow;
  const expectedFlow: TriadStageName[] = ['plan', 'build', 'challenge', 'fix', 'prove', 'approve'];
  if (!Array.isArray(flow) || flow.join(',') !== expectedFlow.join(',')) {
    throw new Error(`[triad-policy] flow must be ${expectedFlow.join(' -> ')}`);
  }
  const loop = value.loop as Record<string, unknown>;
  if (!Number.isInteger(loop.maxFixIterations) || Number(loop.maxFixIterations) < 1 || Number(loop.maxFixIterations) > 3) {
    throw new Error('[triad-policy] maxFixIterations must be between 1 and 3');
  }
  const parallelism = value.parallelism as Record<string, unknown>;
  if (parallelism['claude-code'] !== 1 || parallelism.agy !== 1 || Number(parallelism.codex) > 2) {
    throw new Error('[triad-policy] safe concurrency requires Claude=1, AGY=1, Codex<=2');
  }
  const isolation = parallelism.isolation;
  if (!isRecord(isolation) || Number(isolation.lockTtlMs) <= Number(loop.runTimeoutMs)) {
    throw new Error('[triad-policy] lockTtlMs must exceed runTimeoutMs; lock takeover during a live run is forbidden');
  }
  return value as unknown as TriadPolicy;
}

export function loadTriadPolicy(): TriadPolicy {
  return loadJSON<TriadPolicy>('triad-orchestration.json', validateTriadPolicy);
}

function includesPattern(text: string, patterns: string[]): boolean {
  const normalized = text.toLowerCase();
  return patterns.some(pattern => normalized.includes(pattern.toLowerCase()));
}

export function shouldInvokeAgy(prompt: string, taskType: TaskType, policy = loadTriadPolicy()): boolean {
  return policy.routing.experienceTaskTypes.includes(taskType)
    || includesPattern(prompt, policy.routing.experiencePatterns);
}

export function inferTriadRisk(prompt: string, complexity: number, policy = loadTriadPolicy()): TriadRisk {
  if (includesPattern(prompt, policy.routing.highRiskPatterns) || complexity >= 8) return 'high';
  if (complexity >= 5) return 'medium';
  return 'low';
}

export function buildTriadPlan(
  prompt: string,
  requestedProfile?: TriadProfileName,
  policy = loadTriadPolicy(),
): TriadPlan {
  const taskType = smartRouter.inferTaskType(prompt);
  const complexity = smartRouter.analyzeComplexity(prompt);
  const risk = inferTriadRisk(prompt, complexity, policy);
  const experience = shouldInvokeAgy(prompt, taskType, policy);
  const profile: TriadProfileName = requestedProfile
    ?? (experience ? 'experience' : risk === 'high' ? 'ultra' : risk === 'low' && complexity <= 3 ? 'fast' : 'standard');
  const profilePolicy = policy.profiles[profile];
  const useExperience = profilePolicy.experienceChallenge && experience;
  const commander = profilePolicy.commanderPlan;
  const judge = profilePolicy.commanderApproval;

  const owner: Record<TriadStageName, string> = {
    plan: 'claude-code',
    build: 'codex',
    challenge: useExperience ? 'agy' : (judge ? 'claude-code' : 'deterministic-gate'),
    fix: 'codex',
    prove: 'deterministic-gate',
    approve: judge ? 'claude-code' : 'deterministic-gate',
  };
  const active: Record<TriadStageName, boolean> = {
    plan: commander,
    build: true,
    challenge: useExperience || judge,
    fix: false,
    prove: true,
    approve: true,
  };
  const requiredEvidence = [
    ...policy.evidence.code,
    ...(useExperience ? policy.evidence.experience : []),
  ];

  return {
    profile,
    taskType,
    complexity,
    risk,
    providers: { commander, builder: true, experience: useExperience, judge },
    stages: policy.flow.map(name => ({ name, active: active[name], owner: owner[name] })),
    requiredEvidence: [...new Set(requiredEvidence)],
    maxFixIterations: policy.loop.maxFixIterations,
    maxPaidCalls: profilePolicy.maxPaidCalls,
  };
}

function throughput(sample: EfficiencySample): number {
  if (sample.wallClockHours <= 0) return 0;
  return sample.verifiedCompletions / sample.wallClockHours;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function certifyEfficiency(
  baseline: EfficiencySample,
  candidate: EfficiencySample,
  policy = loadTriadPolicy(),
): EfficiencyCertification {
  const baselineThroughput = throughput(baseline);
  const candidateThroughput = throughput(candidate);
  const multiplier = baselineThroughput > 0 ? candidateThroughput / baselineThroughput : null;
  const wallClockSpeedup = candidate.wallClockHours > 0 && baseline.wallClockHours > 0
    ? baseline.wallClockHours / candidate.wallClockHours
    : null;
  const parallelEfficiency = wallClockSpeedup !== null && candidate.averageConcurrentWorkers > 0
    ? wallClockSpeedup / candidate.averageConcurrentWorkers
    : null;
  const reasons: string[] = [];

  if (multiplier === null || multiplier < policy.kpi.targetMultiplier) {
    reasons.push(`throughput multiplier must be >= ${policy.kpi.targetMultiplier}`);
  }
  if (candidate.falsePassRate > baseline.falsePassRate) {
    reasons.push('false-pass rate increased');
  }
  if (candidate.postMergeDefectsPer100 > baseline.postMergeDefectsPer100) {
    reasons.push('post-merge defects increased');
  }
  if (parallelEfficiency === null || parallelEfficiency <= policy.kpi.minimumParallelEfficiency) {
    reasons.push(`parallel efficiency must be > ${policy.kpi.minimumParallelEfficiency}`);
  }

  return {
    multiplier,
    parallelEfficiency,
    certified: reasons.length === 0,
    reasons,
  };
}

export function certifyEfficiencyRuns(
  baselines: EfficiencySample[],
  candidates: EfficiencySample[],
  policy = loadTriadPolicy(),
): EfficiencyBatchCertification {
  const repeats = Math.min(baselines.length, candidates.length);
  const reasons: string[] = [];
  if (baselines.length !== candidates.length) {
    reasons.push('baseline and candidate repeat counts must match');
  }
  if (repeats < policy.kpi.minimumRepeats) {
    reasons.push(`at least ${policy.kpi.minimumRepeats} paired repeats are required`);
  }

  const pairedBaselines = baselines.slice(0, repeats);
  const pairedCandidates = candidates.slice(0, repeats);
  const baselineThroughputMedian = median(pairedBaselines.map(throughput));
  const candidateThroughputMedian = median(pairedCandidates.map(throughput));
  const multiplier = baselineThroughputMedian !== null
    && baselineThroughputMedian > 0
    && candidateThroughputMedian !== null
    ? candidateThroughputMedian / baselineThroughputMedian
    : null;
  const parallelEfficiency = median(pairedCandidates.map((candidate, index) => {
    const baseline = pairedBaselines[index];
    if (!baseline || baseline.wallClockHours <= 0 || candidate.wallClockHours <= 0 || candidate.averageConcurrentWorkers <= 0) {
      return 0;
    }
    return (baseline.wallClockHours / candidate.wallClockHours) / candidate.averageConcurrentWorkers;
  }));
  const baselineFalsePass = median(pairedBaselines.map(sample => sample.falsePassRate));
  const candidateFalsePass = median(pairedCandidates.map(sample => sample.falsePassRate));
  const baselinePostMergeDefects = median(pairedBaselines.map(sample => sample.postMergeDefectsPer100));
  const candidatePostMergeDefects = median(pairedCandidates.map(sample => sample.postMergeDefectsPer100));

  if (multiplier === null || multiplier < policy.kpi.targetMultiplier) {
    reasons.push(`median throughput multiplier must be >= ${policy.kpi.targetMultiplier}`);
  }
  if (
    baselineFalsePass === null
    || candidateFalsePass === null
    || candidateFalsePass > baselineFalsePass
  ) {
    reasons.push('median false-pass rate increased or is unavailable');
  }
  if (
    baselinePostMergeDefects === null
    || candidatePostMergeDefects === null
    || candidatePostMergeDefects > baselinePostMergeDefects
  ) {
    reasons.push('median post-merge defects increased or are unavailable');
  }
  if (parallelEfficiency === null || parallelEfficiency <= policy.kpi.minimumParallelEfficiency) {
    reasons.push(`median parallel efficiency must be > ${policy.kpi.minimumParallelEfficiency}`);
  }

  return {
    repeats,
    baselineThroughputMedian,
    candidateThroughputMedian,
    multiplier,
    parallelEfficiency,
    certified: reasons.length === 0,
    reasons,
  };
}

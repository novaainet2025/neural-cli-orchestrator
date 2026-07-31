import { createHash } from 'node:crypto';

export type ProviderAssignmentScope = 'organization' | 'team';
export type ProviderAssignmentFallback = 'strict' | 'relax-preferences' | 'any-allowed';
export type ProviderCost = 'free' | 'paid';
export type ProviderType = 'cli' | 'api' | 'local';

export interface ProviderAssignmentPolicy {
  requiredCapabilities: string[];
  preferredCapabilities: string[];
  preferredRoles: string[];
  deniedProviderIds: string[];
  allowedCosts: ProviderCost[];
  allowedTypes: ProviderType[];
  preferLocal: boolean;
  minimumCandidates: number;
  assignmentSize: number;
  fallback: ProviderAssignmentFallback;
  ttlSeconds: number;
}

export type ProviderAssignmentPolicyOverride = Partial<ProviderAssignmentPolicy>;

export interface ProviderAvailability {
  healthy: boolean;
  circuitState: 'closed' | 'open' | 'half-open' | 'unknown';
  rateLimited: boolean;
  capacityUsed: number;
  capacityTotal: number;
}

export interface ProviderAssignmentCandidateInput {
  id: string;
  enabled: boolean;
  capabilities: string[];
  role: string;
  cost: ProviderCost;
  type: ProviderType;
  score: number;
  availability: ProviderAvailability;
}

export interface ProviderAssignmentCandidate {
  id: string;
  eligible: boolean;
  score: number;
  reasons: string[];
  scoreComponents: {
    preferredCapabilities: number;
    preferredRole: number;
    localPreference: number;
    providerScore: number;
    capacityRatio: number;
  };
}

export interface ProviderAssignmentSnapshot {
  assignmentId: string;
  scopeType: ProviderAssignmentScope;
  scopeId: string;
  status: 'assigned' | 'unassigned';
  primaryProviderId: string | null;
  providerIds: string[];
  policyFingerprint: string;
  providerConfigFingerprint: string;
  availabilityFingerprint: string;
  reason: string;
  candidates: ProviderAssignmentCandidate[];
  createdAt: string;
  validUntil: string;
}

export interface ResolveProviderAssignmentInput {
  scopeType: ProviderAssignmentScope;
  scopeId: string;
  providers: ProviderAssignmentCandidateInput[];
  systemPolicy?: ProviderAssignmentPolicyOverride;
  companyPolicy?: ProviderAssignmentPolicyOverride | null;
  teamPolicy?: ProviderAssignmentPolicyOverride | null;
  taskRequiredCapabilities?: string[];
  now?: Date;
  assignmentId?: string;
}

export const DEFAULT_PROVIDER_ASSIGNMENT_POLICY: ProviderAssignmentPolicy = Object.freeze({
  requiredCapabilities: [],
  preferredCapabilities: [],
  preferredRoles: [],
  deniedProviderIds: [],
  allowedCosts: [],
  allowedTypes: [],
  preferLocal: false,
  minimumCandidates: 1,
  assignmentSize: 1,
  fallback: 'strict',
  ttlSeconds: 300,
});

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function preferChild(child: readonly string[] | undefined, parent: readonly string[]): string[] {
  return unique([...(child ?? []), ...parent]);
}

function finiteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizePolicy(policy: ProviderAssignmentPolicy): ProviderAssignmentPolicy {
  const minimumCandidates = Math.max(1, Math.floor(finiteNonNegative(
    policy.minimumCandidates,
    DEFAULT_PROVIDER_ASSIGNMENT_POLICY.minimumCandidates,
  )));
  return {
    requiredCapabilities: unique(policy.requiredCapabilities),
    preferredCapabilities: unique(policy.preferredCapabilities),
    preferredRoles: unique(policy.preferredRoles),
    deniedProviderIds: unique(policy.deniedProviderIds),
    allowedCosts: unique(policy.allowedCosts) as ProviderCost[],
    allowedTypes: unique(policy.allowedTypes) as ProviderType[],
    preferLocal: policy.preferLocal,
    minimumCandidates,
    assignmentSize: Math.max(1, Math.floor(finiteNonNegative(policy.assignmentSize, 1))),
    fallback: policy.fallback,
    ttlSeconds: Math.max(5, Math.floor(finiteNonNegative(policy.ttlSeconds, 300))),
  };
}

/**
 * Merge order is system -> company -> team -> task capability. Required and denied
 * fields can only become more restrictive. Preference arrays put the narrower scope
 * first, while scalar limits are replaced only when explicitly supplied.
 */
export function mergeProviderAssignmentPolicy(
  system: ProviderAssignmentPolicyOverride = {},
  company: ProviderAssignmentPolicyOverride | null = null,
  team: ProviderAssignmentPolicyOverride | null = null,
  taskRequiredCapabilities: readonly string[] = [],
): ProviderAssignmentPolicy {
  const base: ProviderAssignmentPolicy = {
    ...DEFAULT_PROVIDER_ASSIGNMENT_POLICY,
    ...system,
    requiredCapabilities: unique([
      ...DEFAULT_PROVIDER_ASSIGNMENT_POLICY.requiredCapabilities,
      ...(system.requiredCapabilities ?? []),
    ]),
    preferredCapabilities: preferChild(
      system.preferredCapabilities,
      DEFAULT_PROVIDER_ASSIGNMENT_POLICY.preferredCapabilities,
    ),
    preferredRoles: preferChild(system.preferredRoles, DEFAULT_PROVIDER_ASSIGNMENT_POLICY.preferredRoles),
    deniedProviderIds: unique([
      ...DEFAULT_PROVIDER_ASSIGNMENT_POLICY.deniedProviderIds,
      ...(system.deniedProviderIds ?? []),
    ]),
    allowedCosts: system.allowedCosts ?? DEFAULT_PROVIDER_ASSIGNMENT_POLICY.allowedCosts,
    allowedTypes: system.allowedTypes ?? DEFAULT_PROVIDER_ASSIGNMENT_POLICY.allowedTypes,
  };

  const apply = (
    current: ProviderAssignmentPolicy,
    override: ProviderAssignmentPolicyOverride | null,
  ): ProviderAssignmentPolicy => {
    if (!override) return current;
    return {
      ...current,
      ...override,
      requiredCapabilities: unique([
        ...current.requiredCapabilities,
        ...(override.requiredCapabilities ?? []),
      ]),
      preferredCapabilities: preferChild(override.preferredCapabilities, current.preferredCapabilities),
      preferredRoles: preferChild(override.preferredRoles, current.preferredRoles),
      deniedProviderIds: unique([
        ...current.deniedProviderIds,
        ...(override.deniedProviderIds ?? []),
      ]),
      allowedCosts: override.allowedCosts ?? current.allowedCosts,
      allowedTypes: override.allowedTypes ?? current.allowedTypes,
    };
  };

  const scoped = apply(apply(base, company), team);
  return normalizePolicy({
    ...scoped,
    requiredCapabilities: unique([
      ...scoped.requiredCapabilities,
      ...taskRequiredCapabilities,
    ]),
  });
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function capacityRatio(provider: ProviderAssignmentCandidateInput): number {
  const total = provider.availability.capacityTotal;
  const used = provider.availability.capacityUsed;
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used)) return 0;
  return Math.max(0, Math.min(1, (total - Math.max(0, used)) / total));
}

function evaluateCandidate(
  provider: ProviderAssignmentCandidateInput,
  policy: ProviderAssignmentPolicy,
): ProviderAssignmentCandidate {
  const reasons: string[] = [];
  if (!provider.enabled) reasons.push('not_enabled_by_local_nco');
  if (policy.deniedProviderIds.includes(provider.id)) reasons.push('provider_denied');
  const missing = policy.requiredCapabilities.filter(
    (capability) => !provider.capabilities.includes(capability),
  );
  if (missing.length > 0) reasons.push(`missing_capabilities:${missing.join(',')}`);
  if (policy.allowedCosts.length > 0 && !policy.allowedCosts.includes(provider.cost)) {
    reasons.push(`cost_not_allowed:${provider.cost}`);
  }
  if (policy.allowedTypes.length > 0 && !policy.allowedTypes.includes(provider.type)) {
    reasons.push(`type_not_allowed:${provider.type}`);
  }
  if (!provider.availability.healthy) reasons.push('health_unavailable');
  if (provider.availability.circuitState !== 'closed') {
    reasons.push(`circuit_${provider.availability.circuitState}`);
  }
  if (provider.availability.rateLimited) reasons.push('rate_limited');
  const remainingRatio = capacityRatio(provider);
  if (remainingRatio <= 0) reasons.push('capacity_full');

  const preferredCapabilities = policy.preferredCapabilities.filter(
    (capability) => provider.capabilities.includes(capability),
  ).length;
  const preferredRole = policy.preferredRoles.includes(provider.role) ? 1 : 0;
  const localPreference = policy.preferLocal && provider.type === 'local' ? 1 : 0;
  const providerScore = Number.isFinite(provider.score) ? provider.score : 0;
  // Human-readable aggregate only. Sorting below compares components directly so
  // provider score can never accidentally outrank a preferred-capability match.
  const score = preferredCapabilities * 1_000_000
    + preferredRole * 100_000
    + localPreference * 10_000
    + providerScore * 10
    + remainingRatio;

  return {
    id: provider.id,
    eligible: reasons.length === 0,
    score,
    reasons: reasons.length === 0 ? ['eligible'] : reasons,
    scoreComponents: {
      preferredCapabilities,
      preferredRole,
      localPreference,
      providerScore,
      capacityRatio: remainingRatio,
    },
  };
}

function compareCandidates(left: ProviderAssignmentCandidate, right: ProviderAssignmentCandidate): number {
  if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
  const keys: Array<keyof ProviderAssignmentCandidate['scoreComponents']> = [
    'preferredCapabilities',
    'preferredRole',
    'localPreference',
    'providerScore',
    'capacityRatio',
  ];
  for (const key of keys) {
    const difference = right.scoreComponents[key] - left.scoreComponents[key];
    if (difference !== 0) return difference;
  }
  return left.id.localeCompare(right.id);
}

function providerConfigView(provider: ProviderAssignmentCandidateInput): unknown {
  return {
    id: provider.id,
    enabled: provider.enabled,
    capabilities: [...provider.capabilities].sort(),
    role: provider.role,
    cost: provider.cost,
    type: provider.type,
    score: provider.score,
  };
}

function availabilityView(provider: ProviderAssignmentCandidateInput): unknown {
  return { id: provider.id, ...provider.availability };
}

export function resolveProviderAssignment(
  input: ResolveProviderAssignmentInput,
): ProviderAssignmentSnapshot {
  const policy = mergeProviderAssignmentPolicy(
    input.systemPolicy,
    input.companyPolicy,
    input.scopeType === 'team' ? input.teamPolicy : null,
    input.taskRequiredCapabilities,
  );
  const sortedProviders = [...input.providers].sort((left, right) => left.id.localeCompare(right.id));
  const candidates = sortedProviders.map((provider) => evaluateCandidate(provider, policy));
  candidates.sort(compareCandidates);
  const eligible = candidates.filter((candidate) => candidate.eligible);
  const assigned = eligible.length >= policy.minimumCandidates;
  const selected = assigned ? eligible.slice(0, policy.assignmentSize) : [];
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const validUntil = new Date(now.getTime() + policy.ttlSeconds * 1_000).toISOString();
  const policyFingerprint = fingerprint(policy);
  const providerConfigFingerprint = fingerprint(sortedProviders.map(providerConfigView));
  const availabilityFingerprint = fingerprint(sortedProviders.map(availabilityView));
  const assignmentId = input.assignmentId ?? `pas_${fingerprint({
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    policyFingerprint,
    providerConfigFingerprint,
    availabilityFingerprint,
    createdAt,
  }).slice(0, 24)}`;

  return {
    assignmentId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    status: assigned ? 'assigned' : 'unassigned',
    primaryProviderId: selected[0]?.id ?? null,
    providerIds: selected.map((candidate) => candidate.id),
    policyFingerprint,
    providerConfigFingerprint,
    availabilityFingerprint,
    reason: assigned
      ? `selected_${selected.length}_of_${eligible.length}_eligible`
      : `eligible_candidates_${eligible.length}_below_minimum_${policy.minimumCandidates}`,
    candidates,
    createdAt,
    validUntil,
  };
}

export function assignmentSnapshotIsReusable(
  snapshot: ProviderAssignmentSnapshot,
  expected: Pick<ProviderAssignmentSnapshot,
    'policyFingerprint' | 'providerConfigFingerprint' | 'availabilityFingerprint'>,
  now = new Date(),
): boolean {
  return snapshot.status === 'assigned'
    && Date.parse(snapshot.validUntil) > now.getTime()
    && snapshot.policyFingerprint === expected.policyFingerprint
    && snapshot.providerConfigFingerprint === expected.providerConfigFingerprint
    && snapshot.availabilityFingerprint === expected.availabilityFingerprint;
}

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  MODEL_TIERS,
  resolveProviderModel,
  type ModelAvailability,
  type ModelCostClass,
  type ModelLatencyClass,
  type ModelTier,
  type ProviderConfig,
  type ProviderModelConfig,
} from './provider-catalog.js';

const TIER_RANK = new Map<ModelTier, number>(MODEL_TIERS.map((tier, index) => [tier, index]));
const COST_RANK: Record<ModelCostClass, number> = {
  minimal: 0,
  standard: 1,
  premium: 2,
  unbounded: 3,
};
const LATENCY_RANK: Record<ModelLatencyClass, number> = {
  instant: 0,
  fast: 1,
  standard: 2,
  slow: 3,
};

export interface TaskComplexityFactors {
  complexity: number;
  depth: number;
  risk: number;
  context: number;
  tooling: number;
  verification: number;
}

export interface TaskComplexityClassification {
  score: number;
  requestedTier: ModelTier;
  factors: TaskComplexityFactors;
}

export interface ModelRoutingInput {
  provider: ProviderConfig;
  prompt: string;
  registryRevision?: string | null;
  /**
   * Operator authority: bypasses automatic tier/cost/context/capability ranking.
   * A disabled or unavailable declared model still fails closed.
   */
  manualModel?: string | null;
  requestedTier?: ModelTier;
  requiredCapabilities?: readonly string[];
  maxCostClass?: ModelCostClass;
  contextTokens?: number;
  requiresTools?: boolean;
  verificationRequired?: boolean;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  depth?: number;
  complexity?: number;
}

export interface ModelRoutingFallback {
  modelId: string;
  tier: ModelTier;
  eligible: boolean;
  reasons: string[];
}

export interface ModelRoutingReceipt {
  registryRevision: string;
  providerId: string;
  requestedModelId: string | null;
  requestedTier: ModelTier;
  selectedModelId: string | null;
  selectedTier: ModelTier | null;
  score: number;
  scoreFactors: TaskComplexityFactors;
  requiredCapabilities: string[];
  maxCostClass: ModelCostClass | null;
  reason: 'manual_override' | 'exact_tier' | 'upgrade_for_safety'
    | 'nearest_lower_fallback' | 'provider_default_without_catalog';
  fallbackChain: ModelRoutingFallback[];
  decisionFingerprint: string;
}

let committedRegistryRevision: string | null = null;

/** Commit only after all runtime consumers accept the same Registry v2 snapshot. */
export function commitModelRoutingRegistryRevision(revision: string | null): void {
  committedRegistryRevision = revision?.trim() || null;
}

export function getCommittedModelRoutingRegistryRevision(): string | null {
  return committedRegistryRevision;
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

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function legacyRevision(provider: ProviderConfig): string {
  return `legacy-${fingerprint({
    id: provider.id,
    model: provider.model,
    models: provider.models ?? [],
  }).slice(0, 24)}`;
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function occurrences(prompt: string, pattern: RegExp): number {
  return Math.min(4, prompt.match(pattern)?.length ?? 0);
}

/**
 * Provider-neutral, deterministic classifier. It never inspects provider/model
 * names; only task evidence and explicit caller signals affect the score.
 */
export function classifyTaskModelTier(
  prompt: string,
  signals: Omit<ModelRoutingInput, 'provider' | 'prompt' | 'registryRevision' | 'manualModel'
    | 'requestedTier' | 'requiredCapabilities' | 'maxCostClass'> = {},
): TaskComplexityClassification {
  const normalized = prompt.normalize('NFKC').toLowerCase();
  const complexityHits = occurrences(
    normalized,
    /\b(?:implement|refactor|debug|algorithm|concurren|distributed|integrat|migration)\w*\b|구현|리팩터|디버그|알고리즘|동시성|분산|통합|마이그레이션/g,
  );
  const depthHits = occurrences(
    normalized,
    /\b(?:architect|system design|root cause|trade-?off|deep|multi[- ](?:file|stage|agent))\w*\b|아키텍처|근본\s*원인|심층|다단계|다중\s*파일|설계/g,
  );
  const riskHits = occurrences(
    normalized,
    /\b(?:production|security|privacy|legal|medical|financial|destructive|credential|authorization|audit|deploy)\w*\b|운영|보안|개인정보|법률|의료|금융|파괴적|자격증명|권한|감사|배포/g,
  );
  const toolingHits = occurrences(
    normalized,
    /\b(?:tool|browser|database|sql|api|cli|shell|filesystem)\w*\b|도구|브라우저|데이터베이스|명령|파일\s*시스템/g,
  );
  const verificationHits = occurrences(
    normalized,
    /\b(?:test|verify|validation|proof|benchmark|review|regression)\w*\b|테스트|검증|증명|벤치마크|리뷰|회귀/g,
  );

  const explicitComplexity = signals.complexity === undefined
    ? 0
    : bounded(signals.complexity, 0, 10) * 2;
  const explicitDepth = signals.depth === undefined
    ? 0
    : bounded(signals.depth, 0, 10) * 2;
  const riskSignal = signals.riskLevel === 'critical' ? 30
    : signals.riskLevel === 'high' ? 24
      : signals.riskLevel === 'medium' ? 12
        : 0;
  const contextTokens = bounded(signals.contextTokens ?? 0, 0, Number.MAX_SAFE_INTEGER);

  const factors: TaskComplexityFactors = {
    complexity: Math.min(22, complexityHits * 7 + explicitComplexity),
    depth: Math.min(22, depthHits * 10 + explicitDepth),
    risk: Math.min(30, riskHits * 12 + riskSignal),
    context: Math.min(15, Math.floor(contextTokens / 16_000) * 3 + (normalized.length > 8_000 ? 3 : 0)),
    tooling: Math.min(7, toolingHits * 3 + (signals.requiresTools ? 5 : 0)),
    verification: Math.min(12, verificationHits * 5 + (signals.verificationRequired ? 6 : 0)),
  };
  const score = Math.min(100, Object.values(factors).reduce((total, value) => total + value, 0));
  const scoreTier: ModelTier = score < 15 ? 'light'
    : score < 25 ? 'balanced'
      : score < 60 ? 'heavy'
        : 'frontier';
  const requestedTier: ModelTier = signals.riskLevel === 'critical' ? 'frontier'
    : signals.riskLevel === 'high' && (TIER_RANK.get(scoreTier) ?? 0) < 2 ? 'heavy'
      : scoreTier;
  return { score, requestedTier, factors };
}

function normalizedCapabilities(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .map(value => value.trim().toLowerCase())
    .filter(Boolean))].sort();
}

function normalizedModel(
  model: ProviderModelConfig,
  providerCapabilities: readonly string[],
): Required<Pick<ProviderModelConfig,
  'id' | 'enabled' | 'default' | 'aliases' | 'capabilities' | 'tier'
  | 'reasoningStrength' | 'costClass' | 'latencyClass' | 'availability'>>
  & { contextWindow: number | null } {
  const tier = model.tier ?? 'balanced';
  const tierRank = TIER_RANK.get(tier) ?? 1;
  return {
    id: model.id,
    enabled: model.enabled !== false,
    default: model.default === true,
    aliases: model.aliases ?? [],
    capabilities: normalizedCapabilities(model.capabilities ?? providerCapabilities),
    tier,
    reasoningStrength: model.reasoningStrength ?? [1, 3, 4, 5][tierRank]!,
    costClass: model.costClass ?? (['minimal', 'standard', 'premium', 'unbounded'] as const)[tierRank]!,
    latencyClass: model.latencyClass ?? (['fast', 'standard', 'slow', 'slow'] as const)[tierRank]!,
    contextWindow: model.contextWindow ?? null,
    availability: model.enabled === false ? 'unavailable' : model.availability ?? 'available',
  };
}

function effectiveModels(provider: ProviderConfig): ReturnType<typeof normalizedModel>[] {
  if (provider.models && provider.models.length > 0) {
    return provider.models.map(model => normalizedModel(model, provider.capabilities));
  }
  if (!provider.model?.trim()) return [];
  return [normalizedModel({ id: provider.model, default: true }, provider.capabilities)];
}

function tierPreference(candidate: ModelTier, requested: ModelTier): number {
  const candidateRank = TIER_RANK.get(candidate)!;
  const requestedRank = TIER_RANK.get(requested)!;
  // Prefer an exact tier, then the nearest upgrade. Downgrade only after every
  // usable higher tier is exhausted (nearest-safe fallback).
  return candidateRank >= requestedRank
    ? candidateRank - requestedRank
    : MODEL_TIERS.length + requestedRank - candidateRank;
}

function availabilityRank(availability: ModelAvailability): number {
  return availability === 'available' ? 0 : availability === 'degraded' ? 1 : 2;
}

function manualModelDecision(
  input: ModelRoutingInput,
  classification: TaskComplexityClassification,
  requiredCapabilities: string[],
  models: ReturnType<typeof effectiveModels>,
  registryRevision: string,
): ModelRoutingReceipt {
  const selectedId = resolveProviderModel(input.provider, input.manualModel);
  const selected = models.find(model => model.id === selectedId);
  if (selected && (!selected.enabled || selected.availability === 'unavailable')) {
    throw new Error(`model_unavailable: ${input.provider.id}/${selected.id}`);
  }
  const selectedTier = selected?.tier ?? 'balanced';
  const base = {
    registryRevision,
    providerId: input.provider.id,
    requestedModelId: input.manualModel?.trim() || null,
    requestedTier: input.requestedTier ?? classification.requestedTier,
    selectedModelId: selectedId,
    selectedTier,
    score: classification.score,
    scoreFactors: classification.factors,
    requiredCapabilities,
    maxCostClass: input.maxCostClass ?? null,
    reason: 'manual_override' as const,
    fallbackChain: models.map(model => ({
      modelId: model.id,
      tier: model.tier,
      eligible: model.id === selectedId,
      reasons: model.id === selectedId ? ['manual_override'] : ['not_requested'],
    })),
  };
  return { ...base, decisionFingerprint: fingerprint(base) };
}

export function resolveModelRoutingDecision(input: ModelRoutingInput): ModelRoutingReceipt {
  const classification = classifyTaskModelTier(input.prompt, input);
  const requestedTier = input.requestedTier ?? classification.requestedTier;
  const requiredCapabilities = normalizedCapabilities(input.requiredCapabilities);
  const models = effectiveModels(input.provider);
  const registryRevision = input.registryRevision?.trim()
    || committedRegistryRevision
    || legacyRevision(input.provider);

  if (input.manualModel?.trim()) {
    return manualModelDecision(
      input,
      classification,
      requiredCapabilities,
      models,
      registryRevision,
    );
  }

  if (models.length === 0) {
    const base = {
      registryRevision,
      providerId: input.provider.id,
      requestedModelId: null,
      requestedTier,
      selectedModelId: null,
      selectedTier: null,
      score: classification.score,
      scoreFactors: classification.factors,
      requiredCapabilities,
      maxCostClass: input.maxCostClass ?? null,
      reason: 'provider_default_without_catalog' as const,
      fallbackChain: [],
    };
    return { ...base, decisionFingerprint: fingerprint(base) };
  }

  const maxCostRank = input.maxCostClass === undefined
    ? Number.POSITIVE_INFINITY
    : COST_RANK[input.maxCostClass];
  const evaluated = models.map(model => {
    const reasons: string[] = [];
    if (!model.enabled) reasons.push('disabled');
    if (model.availability === 'unavailable') reasons.push('unavailable');
    const missing = requiredCapabilities.filter(
      capability => !model.capabilities.includes(capability),
    );
    if (missing.length > 0) reasons.push(`missing_capabilities:${missing.join(',')}`);
    if (COST_RANK[model.costClass] > maxCostRank) {
      reasons.push(`cost_budget_exceeded:${model.costClass}`);
    }
    if (
      input.contextTokens !== undefined
      && model.contextWindow !== null
      && input.contextTokens > model.contextWindow
    ) {
      reasons.push(`context_window_exceeded:${model.contextWindow}`);
    }
    return { model, reasons, eligible: reasons.length === 0 };
  });

  const eligible = evaluated.filter(candidate => candidate.eligible).sort((left, right) => {
    const availability = availabilityRank(left.model.availability)
      - availabilityRank(right.model.availability);
    if (availability !== 0) return availability;
    const tier = tierPreference(left.model.tier, requestedTier)
      - tierPreference(right.model.tier, requestedTier);
    if (tier !== 0) return tier;
    const cost = COST_RANK[left.model.costClass] - COST_RANK[right.model.costClass];
    if (cost !== 0) return cost;
    const latency = LATENCY_RANK[left.model.latencyClass] - LATENCY_RANK[right.model.latencyClass];
    if (latency !== 0) return latency;
    const reasoning = right.model.reasoningStrength - left.model.reasoningStrength;
    if (reasoning !== 0) return reasoning;
    return left.model.id.localeCompare(right.model.id);
  });
  const selected = eligible[0]?.model;
  if (!selected) {
    const evidence = evaluated
      .map(candidate => `${candidate.model.id}(${candidate.reasons.join('|')})`)
      .join(',');
    throw new Error(`model_routing_unavailable: ${input.provider.id} [${evidence}]`);
  }

  const requestedRank = TIER_RANK.get(requestedTier)!;
  const selectedRank = TIER_RANK.get(selected.tier)!;
  const reason: ModelRoutingReceipt['reason'] = selectedRank === requestedRank ? 'exact_tier'
    : selectedRank > requestedRank ? 'upgrade_for_safety'
      : 'nearest_lower_fallback';
  const fallbackChain = [
    ...eligible,
    ...evaluated.filter(candidate => !candidate.eligible).sort((left, right) => (
      left.model.id.localeCompare(right.model.id)
    )),
  ].map(candidate => ({
    modelId: candidate.model.id,
    tier: candidate.model.tier,
    eligible: candidate.eligible,
    reasons: candidate.eligible
      ? candidate.model.id === selected.id ? [reason] : ['eligible_fallback']
      : candidate.reasons,
  }));
  const base = {
    registryRevision,
    providerId: input.provider.id,
    requestedModelId: null,
    requestedTier,
    selectedModelId: selected.id,
    selectedTier: selected.tier,
    score: classification.score,
    scoreFactors: classification.factors,
    requiredCapabilities,
    maxCostClass: input.maxCostClass ?? null,
    reason,
    fallbackChain,
  };
  return { ...base, decisionFingerprint: fingerprint(base) };
}

/** Preserve every provider/failover decision while keeping the latest receipt easy to query. */
export function appendModelRoutingReceipt(
  metadata: Record<string, unknown>,
  receipt: ModelRoutingReceipt,
): Record<string, unknown> {
  const prior = Array.isArray(metadata.modelRoutingReceipts)
    ? metadata.modelRoutingReceipts.filter(item => item && typeof item === 'object')
    : [];
  return {
    ...metadata,
    modelRouting: receipt,
    modelRoutingReceipts: [...prior, receipt].slice(-20),
  };
}

/** Atomically append a task receipt without discarding unrelated assignment metadata. */
export function persistModelRoutingReceipt(
  database: Database.Database,
  taskId: string,
  receipt: ModelRoutingReceipt,
): boolean {
  const write = database.transaction(() => {
    const row = database.prepare('SELECT metadata_json FROM tasks WHERE id=?').get(taskId) as
      | { metadata_json: string | null }
      | undefined;
    if (!row) return false;
    let metadata: Record<string, unknown> = {};
    if (row.metadata_json) {
      const parsed: unknown = JSON.parse(row.metadata_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    }
    database.prepare(`
      UPDATE tasks SET metadata_json=?, updated_at=datetime('now') WHERE id=?
    `).run(JSON.stringify(appendModelRoutingReceipt(metadata, receipt)), taskId);
    return true;
  });
  return database.inTransaction ? write() : write.immediate();
}

/**
 * Provider Catalog
 * ----------------
 * `config/ai-providers.json` is the provider/model SSOT. This module turns its
 * deliberately small declarations into the complete runtime contract used by
 * execution, routing, admission and roster surfaces.
 *
 * Explicit values always win. Missing role/capability/routing/runtime values
 * are inferred deterministically, so a conventional provider can be added or
 * removed without editing TypeScript routing tables.
 */

export const PROVIDER_EXECUTORS = [
  'native-cli',
  'orchestrated-cli',
  'openai-api',
] as const;

export type ProviderExecutor = typeof PROVIDER_EXECUTORS[number];

export const PROVIDER_ADAPTERS = [
  'generic',
  'claude',
  'codex',
  'opencode',
  'cursor',
  'agy',
  'aider',
] as const;

export type ProviderAdapter = typeof PROVIDER_ADAPTERS[number];
export type ProviderPromptTransport = 'argv' | 'stdin';
export type ProviderTier = 'brain' | 'worker';
export type ProviderDepartment = 'management' | 'information' | 'execution' | 'quality';
export const MODEL_TIERS = ['light', 'balanced', 'heavy', 'frontier'] as const;
export const MODEL_COST_CLASSES = ['minimal', 'standard', 'premium', 'unbounded'] as const;
export const MODEL_LATENCY_CLASSES = ['instant', 'fast', 'standard', 'slow'] as const;
export const MODEL_AVAILABILITY = ['available', 'degraded', 'unavailable'] as const;

export type ModelTier = typeof MODEL_TIERS[number];
export type ModelCostClass = typeof MODEL_COST_CLASSES[number];
export type ModelLatencyClass = typeof MODEL_LATENCY_CLASSES[number];
export type ModelAvailability = typeof MODEL_AVAILABILITY[number];
export type CatalogTaskType =
  | 'design' | 'code' | 'review' | 'verify' | 'research' | 'ui' | 'media' | 'general';

export interface ProviderModelConfig {
  id: string;
  enabled?: boolean;
  default?: boolean;
  aliases?: string[];
  capabilities?: string[];
  /** Task-complexity tier. Missing values infer to balanced without inspecting model names. */
  tier?: ModelTier;
  /** Provider-neutral reasoning scale (1=lightweight, 5=frontier). */
  reasoningStrength?: number;
  costClass?: ModelCostClass;
  latencyClass?: ModelLatencyClass;
  /** Maximum supported context tokens; null means the provider did not declare it. */
  contextWindow?: number | null;
  /** Runtime catalog availability, independently overridable per PC. */
  availability?: ModelAvailability;
}

export interface ProviderRuntimeConfig {
  executor: ProviderExecutor;
  adapter: ProviderAdapter;
  /** Codex-compatible tool workers use the strict read-only invocation. */
  profile?: 'default' | 'readonly-tool-worker';
  /** Prompt is delivered through exactly one transport. Generic CLIs default to stdin. */
  promptTransport?: ProviderPromptTransport;
}

export interface ProviderRoutingConfig {
  tier: ProviderTier;
  departments: ProviderDepartment[];
  taskTypes: CatalogTaskType[];
  /** Adapter reliability order within a tier; inferred unless explicitly overridden. */
  priority: number;
  /** Whether this provider may participate in multi-provider discussions. */
  discussionEligible: boolean;
  /** Higher values are selected first for discussion admission. */
  discussionPriority: number;
}

export interface ProviderConfig {
  id: string;
  name: string;
  enabled: boolean;
  type: 'cli' | 'api' | 'local';
  role: string;
  score: number;
  model: string | null;
  models?: ProviderModelConfig[];
  command: string | null;
  args: string[];
  endpoint?: string;
  apiKeyRef?: string | null;
  keyRotation?: {
    enabled: boolean;
    envVar: string;
    delimiter: string;
    maxKeys: number;
    cooldownMs: number;
  } | null;
  freeModels?: string[];
  apiConfig?: {
    primary: { provider: string; baseUrl: string; apiKeyRef: string; model: string };
    fallback: { provider: string; baseUrl: string; apiKeyRef: string | null; model: string };
  } | null;
  env: Record<string, string>;
  concurrency: number;
  rateLimitRpm: number;
  cost: 'free' | 'paid';
  capabilities: string[];
  permissions: Record<string, boolean>;
  persona: { systemPrompt: string; tone: string; style: string };
  healthCheck: Record<string, unknown>;
  /** Always populated by loadProviders(); optional only for typed test doubles. */
  runtime?: ProviderRuntimeConfig;
  /** Always populated by loadProviders(); optional only for typed test doubles. */
  routing?: ProviderRoutingConfig;
  platforms?: Array<'darwin' | 'wsl' | 'linux'>;
  note?: string;
}

export type ProviderDeclaration =
  Omit<Partial<ProviderConfig>, 'id' | 'runtime' | 'routing'>
  & Pick<ProviderConfig, 'id'>
  & { runtime?: Partial<ProviderRuntimeConfig>; routing?: Partial<ProviderRoutingConfig> };

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const EXECUTOR_SET = new Set<string>(PROVIDER_EXECUTORS);
const ADAPTER_SET = new Set<string>(PROVIDER_ADAPTERS);
const DEPARTMENT_SET = new Set<string>(['management', 'information', 'execution', 'quality']);
const TASK_TYPE_SET = new Set<string>([
  'design', 'code', 'review', 'verify', 'research', 'ui', 'media', 'general',
]);
const MODEL_TIER_SET = new Set<string>(MODEL_TIERS);
const MODEL_COST_CLASS_SET = new Set<string>(MODEL_COST_CLASSES);
const MODEL_LATENCY_CLASS_SET = new Set<string>(MODEL_LATENCY_CLASSES);
const MODEL_AVAILABILITY_SET = new Set<string>(MODEL_AVAILABILITY);

const MODEL_TIER_DEFAULTS: Record<ModelTier, {
  reasoningStrength: number;
  costClass: ModelCostClass;
  latencyClass: ModelLatencyClass;
}> = {
  light: { reasoningStrength: 1, costClass: 'minimal', latencyClass: 'fast' },
  balanced: { reasoningStrength: 3, costClass: 'standard', latencyClass: 'standard' },
  heavy: { reasoningStrength: 4, costClass: 'premium', latencyClass: 'slow' },
  frontier: { reasoningStrength: 5, costClass: 'unbounded', latencyClass: 'slow' },
};

const ROLE_CAPABILITIES: Record<string, string[]> = {
  commander: ['decision', 'delegation', 'architecture', 'review', 'security', 'code'],
  architect: ['architecture', 'design', 'analysis', 'reasoning'],
  engineer: ['code', 'code-generation', 'generation', 'algorithms', 'testing'],
  coder: ['code', 'code-generation', 'testing', 'analysis'],
  reviewer: ['review', 'code-review', 'bug-detection', 'analysis', 'security'],
  validator: ['verification', 'validation', 'testing', 'analysis'],
  designer: ['design', 'ui-ux', 'patterns', 'visual', 'analysis'],
  researcher: ['research', 'reasoning', 'analysis', 'writing'],
  tooluser: ['tool-use', 'function-calling', 'reasoning', 'analysis'],
  generalist: ['analysis', 'reasoning', 'writing', 'code'],
  worker: ['code', 'analysis', 'testing'],
};

const ROLE_SCORES: Record<string, number> = {
  commander: 95,
  architect: 90,
  engineer: 83,
  coder: 80,
  reviewer: 80,
  validator: 78,
  designer: 85,
  researcher: 78,
  tooluser: 78,
  generalist: 70,
  worker: 70,
};

export const PROVIDER_TASK_CAPABILITIES: Record<CatalogTaskType, string[]> = {
  design: ['design', 'architecture', 'patterns', 'multi-model'],
  code: ['code', 'code-generation', 'generation', 'algorithms'],
  review: ['review', 'code-review', 'bug-detection', 'security'],
  verify: ['verification', 'validation', 'testing'],
  research: ['research', 'reasoning', 'analysis', 'tool-use', 'function-calling'],
  ui: ['ui-ux', 'visual', 'patterns'],
  media: ['media', 'image-generation', 'video-generation', 'visual-ai', 'visual'],
  general: ['code', 'analysis', 'reasoning', 'writing', 'reporting'],
};

/** Role affinity preserves layer intent without coupling a layer to provider IDs. */
const DEPARTMENT_ROLE_PRIORITY: Record<ProviderDepartment, Record<string, number>> = {
  management: { commander: 6, architect: 5, reviewer: 2, generalist: 1 },
  information: { architect: 6, researcher: 6, tooluser: 5, generalist: 4, commander: 3 },
  execution: { engineer: 6, coder: 6, designer: 5, worker: 5, commander: 3, generalist: 2 },
  quality: { reviewer: 6, validator: 6, commander: 5, coder: 3, engineer: 2, generalist: 1 },
};

function normalizedRole(role: string): string {
  return role.toLowerCase().replace(/[^a-z]/g, '');
}

function uniqueStrings(values: readonly string[], label: string): string[] {
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'string') {
      throw new Error(`[provider-catalog] ${label}[${index}] must be string`);
    }
  }
  const normalized = values.map(value => value.trim().toLowerCase()).filter(Boolean);
  const seen = new Set<string>();
  for (const value of normalized) {
    if (seen.has(value)) throw new Error(`[provider-catalog] duplicate ${label}: ${value}`);
    seen.add(value);
  }
  return normalized;
}

function assertModelTokenDoesNotReuseProviderId(
  providerId: string,
  token: string | null | undefined,
  path: string,
): void {
  const normalized = token?.trim().toLowerCase();
  if (normalized && normalized === providerId.trim().toLowerCase()) {
    throw new Error(
      `[provider-catalog] ${path} must not reuse provider id as a model token: ${normalized}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`[provider-catalog] ${label} must be an object`);
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error(`[provider-catalog] ${label} must be an array`);
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      throw new Error(`[provider-catalog] ${label}[${index}] must be string`);
    }
  }
}

/** Validate JSON shapes before inference/defaulting can hide a broken declaration. */
function validateDeclarationShape(raw: Record<string, unknown>): void {
  const label = String(raw.id);
  const scalarTypes: Array<[string, 'string' | 'boolean' | 'number']> = [
    ['id', 'string'], ['name', 'string'], ['enabled', 'boolean'], ['role', 'string'],
    ['score', 'number'], ['concurrency', 'number'], ['rateLimitRpm', 'number'],
    ['type', 'string'], ['cost', 'string'], ['note', 'string'],
  ];
  for (const [field, expected] of scalarTypes) {
    if (raw[field] !== undefined && typeof raw[field] !== expected) {
      throw new Error(`[provider-catalog] ${label}.${field} must be ${expected}`);
    }
  }
  // apiKeyRef is intentionally nullable so an overlay can clear a secret reference.
  if (raw.apiKeyRef !== undefined && raw.apiKeyRef !== null && typeof raw.apiKeyRef !== 'string') {
    throw new Error(`[provider-catalog] ${label}.apiKeyRef must be string or null`);
  }
  for (const field of ['model', 'command', 'endpoint']) {
    if (raw[field] !== undefined && raw[field] !== null && typeof raw[field] !== 'string') {
      throw new Error(`[provider-catalog] ${label}.${field} must be string or null`);
    }
  }
  for (const field of ['args', 'capabilities', 'freeModels', 'platforms']) {
    if (raw[field] !== undefined) assertStringArray(raw[field], `${label}.${field}`);
  }

  if (raw.env !== undefined) {
    assertRecord(raw.env, `${label}.env`);
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value !== 'string') {
        throw new Error(`[provider-catalog] ${label}.env.${key} must be string`);
      }
    }
  }

  if (raw.permissions !== undefined) {
    assertRecord(raw.permissions, `${label}.permissions`);
    for (const [key, value] of Object.entries(raw.permissions)) {
      if (typeof value !== 'boolean') {
        throw new Error(`[provider-catalog] ${label}.permissions.${key} must be boolean`);
      }
    }
    for (const field of [
      'canInitiateCollaboration', 'canDelegateToOthers', 'canSupervise', 'canFinalApprove',
    ]) {
      if (typeof raw.permissions[field] !== 'boolean') {
        throw new Error(`[provider-catalog] ${label}.permissions.${field} must be boolean`);
      }
    }
  }

  if (raw.persona !== undefined) {
    assertRecord(raw.persona, `${label}.persona`);
    for (const field of ['systemPrompt', 'tone', 'style']) {
      if (typeof raw.persona[field] !== 'string') {
        throw new Error(`[provider-catalog] ${label}.persona.${field} must be string`);
      }
    }
  }

  if (raw.healthCheck !== undefined) {
    assertRecord(raw.healthCheck, `${label}.healthCheck`);
    for (const field of ['type', 'command', 'url']) {
      if (raw.healthCheck[field] !== undefined && typeof raw.healthCheck[field] !== 'string') {
        throw new Error(`[provider-catalog] ${label}.healthCheck.${field} must be string`);
      }
    }
    if (raw.healthCheck.args !== undefined) {
      assertStringArray(raw.healthCheck.args, `${label}.healthCheck.args`);
    }
    if (
      raw.healthCheck.timeout !== undefined
      && (typeof raw.healthCheck.timeout !== 'number' || !Number.isFinite(raw.healthCheck.timeout))
    ) {
      throw new Error(`[provider-catalog] ${label}.healthCheck.timeout must be number`);
    }
    if (typeof raw.healthCheck.command !== 'string' && typeof raw.healthCheck.url !== 'string') {
      throw new Error(`[provider-catalog] ${label}.healthCheck must define command or url`);
    }
  }

  if (raw.runtime !== undefined) {
    assertRecord(raw.runtime, `${label}.runtime`);
    for (const field of ['executor', 'adapter', 'profile', 'promptTransport']) {
      if (raw.runtime[field] !== undefined && typeof raw.runtime[field] !== 'string') {
        throw new Error(`[provider-catalog] ${label}.runtime.${field} must be string`);
      }
    }
    const profile = raw.runtime.profile;
    if (profile !== undefined && profile !== 'default' && profile !== 'readonly-tool-worker') {
      throw new Error(`[provider-catalog] ${label}.runtime.profile is unknown: ${String(profile)}`);
    }
    const promptTransport = raw.runtime.promptTransport;
    if (promptTransport !== undefined && promptTransport !== 'argv' && promptTransport !== 'stdin') {
      throw new Error(
        `[provider-catalog] ${label}.runtime.promptTransport is unknown: ${String(promptTransport)}`,
      );
    }
  }

  if (raw.routing !== undefined) {
    assertRecord(raw.routing, `${label}.routing`);
    if (raw.routing.tier !== undefined && typeof raw.routing.tier !== 'string') {
      throw new Error(`[provider-catalog] ${label}.routing.tier must be string`);
    }
    if (
      raw.routing.priority !== undefined
      && (typeof raw.routing.priority !== 'number' || !Number.isFinite(raw.routing.priority))
    ) {
      throw new Error(`[provider-catalog] ${label}.routing.priority must be number`);
    }
    if (
      raw.routing.discussionEligible !== undefined
      && typeof raw.routing.discussionEligible !== 'boolean'
    ) {
      throw new Error(`[provider-catalog] ${label}.routing.discussionEligible must be boolean`);
    }
    if (
      raw.routing.discussionPriority !== undefined
      && (
        typeof raw.routing.discussionPriority !== 'number'
        || !Number.isFinite(raw.routing.discussionPriority)
      )
    ) {
      throw new Error(`[provider-catalog] ${label}.routing.discussionPriority must be number`);
    }
    for (const field of ['departments', 'taskTypes']) {
      if (raw.routing[field] !== undefined) {
        assertStringArray(raw.routing[field], `${label}.routing.${field}`);
      }
    }
  }

  if (raw.keyRotation !== undefined && raw.keyRotation !== null) {
    assertRecord(raw.keyRotation, `${label}.keyRotation`);
    if (typeof raw.keyRotation.enabled !== 'boolean') {
      throw new Error(`[provider-catalog] ${label}.keyRotation.enabled must be boolean`);
    }
    for (const field of ['envVar', 'delimiter']) {
      if (typeof raw.keyRotation[field] !== 'string') {
        throw new Error(`[provider-catalog] ${label}.keyRotation.${field} must be string`);
      }
    }
    for (const field of ['maxKeys', 'cooldownMs']) {
      const value = raw.keyRotation[field];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`[provider-catalog] ${label}.keyRotation.${field} must be a positive integer`);
      }
    }
  }

  if (raw.apiConfig !== undefined && raw.apiConfig !== null) {
    assertRecord(raw.apiConfig, `${label}.apiConfig`);
    for (const branchName of ['primary', 'fallback'] as const) {
      const branch = raw.apiConfig[branchName];
      assertRecord(branch, `${label}.apiConfig.${branchName}`);
      for (const field of ['provider', 'baseUrl', 'model']) {
        if (typeof branch[field] !== 'string') {
          throw new Error(`[provider-catalog] ${label}.apiConfig.${branchName}.${field} must be string`);
        }
      }
      const apiKeyRef = branch.apiKeyRef;
      const nullable = branchName === 'fallback';
      if (typeof apiKeyRef !== 'string' && !(nullable && apiKeyRef === null)) {
        throw new Error(
          `[provider-catalog] ${label}.apiConfig.${branchName}.apiKeyRef must be ${nullable ? 'string or null' : 'string'}`,
        );
      }
    }
  }

  if (raw.models !== undefined) {
    if (!Array.isArray(raw.models)) {
      throw new Error(`[provider-catalog] ${label}.models must be an array`);
    }
    for (const [index, model] of raw.models.entries()) {
      assertRecord(model, `${label}.models[${index}]`);
      const allowedFields = new Set([
        'id', 'enabled', 'default', 'aliases', 'capabilities', 'tier', 'reasoningStrength',
        'costClass', 'latencyClass', 'contextWindow', 'availability',
      ]);
      const unknownFields = Object.keys(model).filter(field => !allowedFields.has(field));
      if (unknownFields.length > 0) {
        throw new Error(
          `[provider-catalog] ${label}.models[${index}] has unknown field(s): ${unknownFields.join(', ')}`,
        );
      }
      if (typeof model.id !== 'string' || !model.id.trim()) {
        throw new Error(`[provider-catalog] ${label}.models[${index}].id is required`);
      }
      for (const field of ['enabled', 'default']) {
        if (model[field] !== undefined && typeof model[field] !== 'boolean') {
          throw new Error(`[provider-catalog] ${label}.models[${index}].${field} must be boolean`);
        }
      }
      for (const field of ['aliases', 'capabilities']) {
        if (model[field] !== undefined) {
          assertStringArray(model[field], `${label}.models[${index}].${field}`);
        }
      }
      if (model.tier !== undefined && (
        typeof model.tier !== 'string' || !MODEL_TIER_SET.has(model.tier)
      )) {
        throw new Error(`[provider-catalog] ${label}.models[${index}].tier is unknown: ${String(model.tier)}`);
      }
      if (model.reasoningStrength !== undefined && (
        typeof model.reasoningStrength !== 'number'
        || !Number.isInteger(model.reasoningStrength)
        || model.reasoningStrength < 1
        || model.reasoningStrength > 5
      )) {
        throw new Error(
          `[provider-catalog] ${label}.models[${index}].reasoningStrength must be an integer from 1 to 5`,
        );
      }
      if (model.costClass !== undefined && (
        typeof model.costClass !== 'string' || !MODEL_COST_CLASS_SET.has(model.costClass)
      )) {
        throw new Error(
          `[provider-catalog] ${label}.models[${index}].costClass is unknown: ${String(model.costClass)}`,
        );
      }
      if (model.latencyClass !== undefined && (
        typeof model.latencyClass !== 'string' || !MODEL_LATENCY_CLASS_SET.has(model.latencyClass)
      )) {
        throw new Error(
          `[provider-catalog] ${label}.models[${index}].latencyClass is unknown: ${String(model.latencyClass)}`,
        );
      }
      if (model.contextWindow !== undefined && model.contextWindow !== null && (
        typeof model.contextWindow !== 'number'
        || !Number.isSafeInteger(model.contextWindow)
        || model.contextWindow < 1
      )) {
        throw new Error(
          `[provider-catalog] ${label}.models[${index}].contextWindow must be a positive integer or null`,
        );
      }
      if (model.availability !== undefined && (
        typeof model.availability !== 'string'
        || !MODEL_AVAILABILITY_SET.has(model.availability)
      )) {
        throw new Error(
          `[provider-catalog] ${label}.models[${index}].availability is unknown: ${String(model.availability)}`,
        );
      }
    }
  }
}

function adapterFromDeclaration(provider: ProviderDeclaration): ProviderAdapter {
  const explicit = provider.runtime?.adapter;
  if (explicit !== undefined) {
    if (!ADAPTER_SET.has(explicit)) {
      throw new Error(`[provider-catalog] ${provider.id}.runtime.adapter is unknown: ${String(explicit)}`);
    }
    return explicit;
  }

  const command = provider.command?.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const signal = `${provider.id} ${provider.name ?? ''} ${command}`.toLowerCase();
  if (/\bclaude(?:-code)?\b/.test(signal)) return 'claude';
  if (/\bopencode\b/.test(signal)) return 'opencode';
  if (/\bcursor(?:-agent)?\b/.test(signal)) return 'cursor';
  if (/\bagy\b/.test(signal)) return 'agy';
  if (/\baider\b/.test(signal)) return 'aider';
  if (/\bcodex\b/.test(signal)) return 'codex';
  return 'generic';
}

function inferRuntimeProfile(
  provider: ProviderDeclaration,
  adapter: ProviderAdapter,
): 'default' | 'readonly-tool-worker' {
  if (provider.runtime?.profile) return provider.runtime.profile;
  const role = normalizedRole(provider.role ?? '');
  const capabilities = new Set(provider.capabilities ?? []);
  return adapter === 'codex'
    && (role === 'tooluser' || capabilities.has('tool-use') || capabilities.has('function-calling'))
    ? 'readonly-tool-worker'
    : 'default';
}

function executorFromDeclaration(
  provider: ProviderDeclaration,
  adapter: ProviderAdapter,
): ProviderExecutor {
  const explicit = provider.runtime?.executor;
  if (explicit !== undefined) {
    if (!EXECUTOR_SET.has(explicit)) {
      throw new Error(`[provider-catalog] ${provider.id}.runtime.executor is unknown: ${String(explicit)}`);
    }
    return explicit;
  }
  if (provider.type === 'api' || provider.type === 'local') return 'openai-api';
  if (adapter === 'claude') return 'native-cli';
  return 'orchestrated-cli';
}

function inferRole(provider: ProviderDeclaration, adapter: ProviderAdapter): string {
  if (provider.role?.trim()) return provider.role.trim();
  const signal = `${provider.id} ${provider.name ?? ''} ${provider.model ?? ''}`.toLowerCase();
  if (adapter === 'claude' || /commander|supervisor|delegate/.test(signal)) return 'Commander';
  if (adapter === 'opencode' || /architect/.test(signal)) return 'Architect';
  if (adapter === 'cursor' || /review/.test(signal)) return 'Reviewer';
  if (adapter === 'agy' || /design|\bui\b/.test(signal)) return 'Designer';
  if (/validat|verif|\bqa\b/.test(signal)) return 'Validator';
  if (/research/.test(signal)) return 'Researcher';
  if (/tool|function.call/.test(signal)) return 'ToolUser';
  if (adapter === 'codex' || adapter === 'aider' || /code|engineer/.test(signal)) return 'Engineer';
  return 'Generalist';
}

function inferCapabilities(provider: ProviderDeclaration, role: string): string[] {
  if (provider.capabilities !== undefined) {
    return uniqueStrings(provider.capabilities, `${provider.id}.capability`);
  }
  return [...(ROLE_CAPABILITIES[role.toLowerCase().replace(/[^a-z]/g, '')] ?? ROLE_CAPABILITIES.generalist)];
}

function inferTaskTypes(capabilities: readonly string[]): CatalogTaskType[] {
  const available = new Set(capabilities);
  const inferred = (Object.keys(PROVIDER_TASK_CAPABILITIES) as CatalogTaskType[])
    .filter(taskType => PROVIDER_TASK_CAPABILITIES[taskType]
      .some(capability => available.has(capability)));
  return inferred.length > 0 ? inferred : ['general'];
}

function inferDepartments(role: string, capabilities: readonly string[]): ProviderDepartment[] {
  const available = new Set(capabilities);
  const departments: ProviderDepartment[] = [];
  if (
    role.toLowerCase() === 'commander'
    || ['decision', 'delegation', 'architecture'].some(capability => available.has(capability))
  ) departments.push('management');
  if (
    ['analysis', 'reasoning', 'research', 'tool-use', 'function-calling', 'writing']
      .some(capability => available.has(capability))
  ) departments.push('information');
  if (
    ['code', 'code-generation', 'generation', 'algorithms', 'ui-ux', 'media']
      .some(capability => available.has(capability))
  ) departments.push('execution');
  if (
    ['review', 'code-review', 'bug-detection', 'security', 'testing', 'validation', 'verification']
      .some(capability => available.has(capability))
  ) departments.push('quality');
  return departments.length > 0 ? departments : ['execution'];
}

function normalizeModels(
  provider: ProviderDeclaration,
  providerCapabilities: readonly string[],
): ProviderModelConfig[] | undefined {
  if (provider.models === undefined) return undefined;
  const seenTokens = new Set<string>();
  let defaults = 0;
  const normalized = provider.models.map((model, index) => {
    if (!model || typeof model !== 'object' || typeof model.id !== 'string' || !model.id.trim()) {
      throw new Error(`[provider-catalog] ${provider.id}.models[${index}].id is required`);
    }
    const id = model.id.trim();
    const aliases = uniqueStrings(model.aliases ?? [], `${provider.id}.model alias`);
    assertModelTokenDoesNotReuseProviderId(provider.id, id, `${provider.id}.models[${index}].id`);
    for (const [aliasIndex, alias] of aliases.entries()) {
      assertModelTokenDoesNotReuseProviderId(
        provider.id,
        alias,
        `${provider.id}.models[${index}].aliases[${aliasIndex}]`,
      );
    }
    const tokens = [id.toLowerCase(), ...aliases];
    for (const token of tokens) {
      if (seenTokens.has(token)) {
        throw new Error(`[provider-catalog] duplicate ${provider.id} model id/alias: ${token}`);
      }
      seenTokens.add(token);
    }
    if (model.default && model.enabled === false) {
      throw new Error(`[provider-catalog] ${provider.id}.${id} default model must be enabled`);
    }
    if (model.default && model.availability === 'unavailable') {
      throw new Error(`[provider-catalog] ${provider.id}.${id} default model must be available`);
    }
    if (model.default) defaults += 1;
    const tier = model.tier ?? 'balanced';
    const tierDefaults = MODEL_TIER_DEFAULTS[tier];
    const enabled = model.enabled !== false;
    return {
      id,
      enabled,
      default: model.default === true,
      aliases,
      capabilities: model.capabilities
        ? uniqueStrings(model.capabilities, `${provider.id}.${id}.capability`)
        : [...providerCapabilities],
      tier,
      reasoningStrength: model.reasoningStrength ?? tierDefaults.reasoningStrength,
      costClass: model.costClass ?? tierDefaults.costClass,
      latencyClass: model.latencyClass ?? tierDefaults.latencyClass,
      contextWindow: model.contextWindow ?? null,
      availability: enabled ? model.availability ?? 'available' : 'unavailable',
    };
  });
  if (defaults > 1) {
    throw new Error(`[provider-catalog] ${provider.id}.models has more than one default`);
  }
  if (defaults === 0) {
    const requested = provider.model?.trim().toLowerCase();
    const fallback = normalized.find(model => model.enabled !== false
      && model.availability !== 'unavailable' && requested
      && (model.id.toLowerCase() === requested || model.aliases?.includes(requested)))
      ?? normalized.find(model => model.enabled !== false && model.availability !== 'unavailable');
    if (fallback) fallback.default = true;
  }
  return normalized;
}

function resolveDefaultModel(
  provider: ProviderDeclaration,
  models: ProviderModelConfig[] | undefined,
): string | null {
  const requested = provider.model?.trim() || null;
  if (models === undefined) return requested;
  const enabled = models.filter(
    model => model.enabled !== false && model.availability !== 'unavailable',
  );
  if (enabled.length === 0 && provider.enabled !== false) {
    throw new Error(`[provider-catalog] ${provider.id} is enabled but has no enabled model`);
  }
  if (requested) {
    const match = enabled.find(model =>
      model.id === requested || model.aliases?.includes(requested.toLowerCase()));
    if (!match) {
      throw new Error(`[provider-catalog] ${provider.id}.model is not an enabled catalog model: ${requested}`);
    }
    return match.id;
  }
  return enabled.find(model => model.default)?.id ?? enabled[0]?.id ?? null;
}

function normalizeRouting(
  provider: ProviderDeclaration,
  role: string,
  capabilities: string[],
  cost: 'free' | 'paid',
): ProviderRoutingConfig {
  const explicitDepartments = provider.routing?.departments;
  const departments = explicitDepartments === undefined
    ? inferDepartments(role, capabilities)
    : uniqueStrings(explicitDepartments, `${provider.id}.department`) as ProviderDepartment[];
  for (const department of departments) {
    if (!DEPARTMENT_SET.has(department)) {
      throw new Error(`[provider-catalog] ${provider.id}.routing.department is unknown: ${department}`);
    }
  }

  const explicitTaskTypes = provider.routing?.taskTypes;
  const taskTypes = explicitTaskTypes === undefined
    ? inferTaskTypes(capabilities)
    : uniqueStrings(explicitTaskTypes, `${provider.id}.taskType`) as CatalogTaskType[];
  for (const taskType of taskTypes) {
    if (!TASK_TYPE_SET.has(taskType)) {
      throw new Error(`[provider-catalog] ${provider.id}.routing.taskType is unknown: ${taskType}`);
    }
  }

  const tier = provider.routing?.tier ?? (cost === 'paid' ? 'brain' : 'worker');
  if (tier !== 'brain' && tier !== 'worker') {
    throw new Error(`[provider-catalog] ${provider.id}.routing.tier is unknown: ${String(tier)}`);
  }
  const adapter = adapterFromDeclaration(provider);
  const profile = inferRuntimeProfile(provider, adapter);
  const inferredPriority = adapter === 'claude' ? 600
    : adapter === 'codex' && profile !== 'readonly-tool-worker' ? 500
      : adapter === 'cursor' ? 400
        : adapter === 'opencode' ? 300
          : adapter === 'generic' || adapter === 'aider' ? 200
            : adapter === 'codex' ? 150
              : 100;
  const priority = provider.routing?.priority ?? inferredPriority;
  if (!Number.isFinite(priority)) {
    throw new Error(`[provider-catalog] ${provider.id}.routing.priority must be number`);
  }
  const discussionEligible = provider.routing?.discussionEligible ?? true;
  const discussionPriority = provider.routing?.discussionPriority ?? priority;
  if (!Number.isFinite(discussionPriority)) {
    throw new Error(`[provider-catalog] ${provider.id}.routing.discussionPriority must be number`);
  }
  return {
    tier,
    departments,
    taskTypes,
    priority,
    discussionEligible,
    discussionPriority,
  };
}

export function normalizeProviderDeclaration(provider: ProviderDeclaration): ProviderConfig {
  if (!provider || typeof provider !== 'object') {
    throw new Error('[provider-catalog] provider declaration must be an object');
  }
  const raw = provider as unknown as Record<string, unknown>;
  validateDeclarationShape(raw);
  const id = provider.id?.trim();
  if (!id || !ID_PATTERN.test(id)) {
    throw new Error(`[provider-catalog] invalid provider id: ${String(provider.id)}`);
  }
  assertModelTokenDoesNotReuseProviderId(id, provider.model, `${id}.model`);
  for (const [index, freeModel] of (provider.freeModels ?? []).entries()) {
    assertModelTokenDoesNotReuseProviderId(id, freeModel, `${id}.freeModels[${index}]`);
  }
  const type = provider.type ?? (provider.endpoint ? 'api' : 'cli');
  if (!['cli', 'api', 'local'].includes(type)) {
    throw new Error(`[provider-catalog] ${id}.type is unknown: ${String(type)}`);
  }

  const adapter = adapterFromDeclaration({ ...provider, id, type });
  const executor = executorFromDeclaration({ ...provider, id, type }, adapter);
  if (
    adapter !== 'generic'
    && provider.runtime?.promptTransport !== undefined
    && provider.runtime.promptTransport !== 'argv'
  ) {
    throw new Error(
      `[provider-catalog] ${id}.${adapter} adapter requires runtime.promptTransport=argv`,
    );
  }
  if (executor === 'openai-api' && !provider.endpoint) {
    throw new Error(`[provider-catalog] ${id} uses openai-api but endpoint is missing`);
  }
  if (executor !== 'openai-api' && !provider.command) {
    throw new Error(`[provider-catalog] ${id} uses ${executor} but command is missing`);
  }
  if (executor === 'native-cli' && adapter !== 'claude') {
    throw new Error(`[provider-catalog] ${id} native-cli currently requires adapter=claude`);
  }

  const role = inferRole(provider, adapter);
  const capabilities = inferCapabilities(provider, role);
  const cost = provider.cost ?? (type === 'local' ? 'free' : 'paid');
  if (cost !== 'free' && cost !== 'paid') {
    throw new Error(`[provider-catalog] ${id}.cost is unknown: ${String(cost)}`);
  }
  const models = normalizeModels(provider, capabilities);
  const model = resolveDefaultModel(provider, models);
  const roleKey = normalizedRole(role);
  const score = provider.score ?? ROLE_SCORES[roleKey] ?? ROLE_SCORES.generalist;
  const concurrency = provider.concurrency ?? 2;
  const rateLimitRpm = provider.rateLimitRpm ?? 20;
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`[provider-catalog] ${id}.score must be between 0 and 100`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`[provider-catalog] ${id}.concurrency must be a positive integer`);
  }
  if (!Number.isInteger(rateLimitRpm) || rateLimitRpm < 1) {
    throw new Error(`[provider-catalog] ${id}.rateLimitRpm must be a positive integer`);
  }

  const permissions = provider.permissions ?? {
    canInitiateCollaboration: true,
    canDelegateToOthers: roleKey === 'commander' || roleKey === 'architect',
    canSupervise: roleKey === 'commander' || roleKey === 'architect',
    canFinalApprove: roleKey === 'commander',
  };
  const persona = provider.persona ?? {
    systemPrompt: `You are the ${role} of the NCO AI team. Verify evidence before claiming completion.`,
    tone: roleKey === 'commander' ? 'authoritative' : 'concise',
    style: roleKey === 'engineer' ? 'code-focused' : 'professional',
  };
  const healthCheck = provider.healthCheck ?? (executor === 'openai-api'
    ? { type: 'api', url: provider.endpoint, timeout: 5000 }
    : { type: 'command', command: provider.command, args: ['--version'], timeout: 5000 });

  return {
    ...provider,
    id,
    name: provider.name?.trim() || id,
    enabled: provider.enabled !== false,
    type,
    role,
    score,
    model,
    models,
    command: provider.command ?? null,
    args: provider.args ?? [],
    env: provider.env ?? {},
    concurrency,
    rateLimitRpm,
    cost,
    capabilities,
    permissions,
    persona,
    healthCheck,
    runtime: {
      executor,
      adapter,
      profile: inferRuntimeProfile({ ...provider, role, capabilities }, adapter),
      promptTransport: provider.runtime?.promptTransport ?? (adapter === 'generic' ? 'stdin' : 'argv'),
    },
    routing: normalizeRouting(provider, role, capabilities, cost),
  };
}

export function buildProviderCatalog(declarations: readonly ProviderDeclaration[]): ProviderConfig[] {
  const seen = new Set<string>();
  return declarations.map((declaration, index) => {
    const provider = normalizeProviderDeclaration(declaration);
    if (seen.has(provider.id)) {
      throw new Error(`[provider-catalog] duplicate provider id at index ${index}: ${provider.id}`);
    }
    seen.add(provider.id);
    return provider;
  });
}

export function resolveProviderModel(
  provider: ProviderConfig,
  requestedModel?: string | null,
): string | null {
  const requested = requestedModel?.trim();
  if (!requested) return provider.model;
  if (!provider.models || provider.models.length === 0) return requested;
  const normalized = requested.toLowerCase();
  const match = provider.models.find(model =>
    model.enabled !== false
    && model.availability !== 'unavailable'
    && (model.id.toLowerCase() === normalized || model.aliases?.includes(normalized)));
  if (!match) {
    throw new Error(`unknown_model: ${provider.id}/${requested}`);
  }
  return match.id;
}

/** Runtime contract for normalized configs and legacy/test declarations alike. */
export function resolveProviderRuntime(provider: ProviderDeclaration): ProviderRuntimeConfig {
  const adapter = adapterFromDeclaration(provider);
  return {
    adapter,
    executor: executorFromDeclaration(provider, adapter),
    profile: inferRuntimeProfile(provider, adapter),
    promptTransport: provider.runtime?.promptTransport ?? (adapter === 'generic' ? 'stdin' : 'argv'),
  };
}

/** Routing contract for normalized configs and legacy/test declarations alike. */
export function resolveProviderRouting(provider: ProviderDeclaration): ProviderRoutingConfig {
  if (
    provider.routing?.tier
    && provider.routing.departments
    && provider.routing.taskTypes
    && provider.routing.priority !== undefined
    && provider.routing.discussionEligible !== undefined
    && provider.routing.discussionPriority !== undefined
  ) {
    return provider.routing as ProviderRoutingConfig;
  }
  const role = inferRole(provider, adapterFromDeclaration(provider));
  const capabilities = inferCapabilities(provider, role);
  const cost = provider.cost ?? (provider.type === 'local' ? 'free' : 'paid');
  return normalizeRouting(provider, role, capabilities, cost);
}

export function providersForDepartment(
  providers: readonly ProviderConfig[],
  department: ProviderDepartment,
  enabledOnly = true,
): ProviderConfig[] {
  return providers
    .filter(provider =>
      (!enabledOnly || provider.enabled)
      && resolveProviderRouting(provider).departments.includes(department))
    .sort((left, right) => {
      const priority = DEPARTMENT_ROLE_PRIORITY[department];
      const byRole = (priority[normalizedRole(right.role)] ?? 0)
        - (priority[normalizedRole(left.role)] ?? 0);
      return byRole || right.score - left.score || left.id.localeCompare(right.id);
    });
}

export function providersForTaskType(
  providers: readonly ProviderConfig[],
  taskType: CatalogTaskType,
  enabledOnly = true,
): ProviderConfig[] {
  return providers
    .filter(provider =>
      (!enabledOnly || provider.enabled)
      && resolveProviderRouting(provider).taskTypes.includes(taskType))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

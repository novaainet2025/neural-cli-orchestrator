const MLX_MODEL_ROOT = '/Users/nova-ai/project/LM-models/mlx';

export const MLX_MODEL_ALIASES: Record<string, string> = {
  'glm-5': `${MLX_MODEL_ROOT}/GLM-5-4bit`,
  'qwen3': `${MLX_MODEL_ROOT}/Qwen3-30B-A3B-Instruct-2507-4bit`,
  'qwen3-30b': `${MLX_MODEL_ROOT}/Qwen3-30B-A3B-Instruct-2507-4bit`,
  'qwen3-30b-instruct': `${MLX_MODEL_ROOT}/Qwen3-30B-A3B-Instruct-2507-4bit`,
  'qwen3-coder': `${MLX_MODEL_ROOT}/Qwen3-Coder-30B-A3B-Instruct-4bit`,
  'qwen3-coder-30b': `${MLX_MODEL_ROOT}/Qwen3-Coder-30B-A3B-Instruct-4bit`,
  'qwen3-instruct': `${MLX_MODEL_ROOT}/Qwen3-30B-A3B-Instruct-2507-4bit`,
};

const MLX_PROVIDER_IDS = new Set(['mlx', 'mlx-instruct', 'hermes']);

export interface MlxModelProviderLike {
  id: string;
  model: string | null;
  endpoint?: string;
}

function normalizeAliasKey(model: string): string {
  return model.trim().toLowerCase();
}

function usesLocalMlxEndpoint(endpoint?: string): boolean {
  return Boolean(endpoint && /127\.0\.0\.1:8000\/v1|localhost:8000\/v1/.test(endpoint));
}

export function resolveMlxModelAlias(model: string | null | undefined): string | null {
  if (!model) return null;
  return MLX_MODEL_ALIASES[normalizeAliasKey(model)] ?? model;
}

export function resolveProviderModel(provider: MlxModelProviderLike): string | null {
  if (!provider.model) return null;
  if (!MLX_PROVIDER_IDS.has(provider.id) && !usesLocalMlxEndpoint(provider.endpoint)) {
    return provider.model;
  }
  return resolveMlxModelAlias(provider.model);
}

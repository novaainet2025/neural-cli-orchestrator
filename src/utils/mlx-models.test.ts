import { describe, expect, it } from 'vitest';
import { resolveMlxModelAlias, resolveProviderModel } from './mlx-models.js';

describe('mlx-models', () => {
  it('maps qwen3 aliases to the instruct model path', () => {
    expect(resolveMlxModelAlias('qwen3-30b')).toBe(
      '/Users/nova-ai/project/LM-models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit',
    );
    expect(resolveMlxModelAlias('qwen3-instruct')).toBe(
      '/Users/nova-ai/project/LM-models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit',
    );
  });

  it('keeps absolute model paths unchanged', () => {
    const modelPath = '/Users/nova-ai/project/LM-models/mlx/Qwen3-Coder-30B-A3B-Instruct-4bit';
    expect(resolveMlxModelAlias(modelPath)).toBe(modelPath);
  });

  it('resolves only mlx-family providers', () => {
    expect(resolveProviderModel({
      id: 'mlx',
      model: 'qwen3-30b',
      endpoint: 'http://127.0.0.1:8000/v1',
    })).toBe('/Users/nova-ai/project/LM-models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit');

    expect(resolveProviderModel({
      id: 'openrouter',
      model: 'qwen3-30b',
      endpoint: 'https://openrouter.ai/api/v1',
    })).toBe('qwen3-30b');
  });
});

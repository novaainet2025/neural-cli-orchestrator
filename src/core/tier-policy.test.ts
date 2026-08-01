import { afterEach, describe, expect, it } from 'vitest';
import { normalizeProviderDeclaration } from './provider-catalog.js';
import { __setRegistryForTest } from './provider-registry.js';
import { brainTier, classifyTier, orderByTier } from './tier-policy.js';

afterEach(() => __setRegistryForTest(null));

describe('tier policy analysis intent', () => {
  it.each([
    'nova-cli 장단점 알려줘',
    '실패 원인을 분석해',
    '두 구현을 비교해',
  ])('routes evidence and judgment requests to the brain tier: %s', (prompt) => {
    expect(classifyTier(prompt, 3)).toBe('brain');
  });

  it('keeps a mechanical implementation request on the worker tier', () => {
    expect(classifyTier('동일한 파일 100개를 일괄 포맷 적용해', 3)).toBe('worker');
  });

  it('recomputes brain order from a changed registry without provider id tables', () => {
    __setRegistryForTest([
      normalizeProviderDeclaration({
        id: 'brain-low', command: 'brain-low', cost: 'paid', score: 60,
        routing: { tier: 'brain', departments: ['management'], taskTypes: ['general'], priority: 10 },
      }),
      normalizeProviderDeclaration({
        id: 'brain-high', command: 'brain-high', cost: 'paid', score: 90,
        routing: { tier: 'brain', departments: ['management'], taskTypes: ['general'], priority: 90 },
      }),
      normalizeProviderDeclaration({
        id: 'worker-local', command: 'worker-local', cost: 'free', score: 80,
        routing: { tier: 'worker', departments: ['execution'], taskTypes: ['code'], priority: 50 },
      }),
    ]);
    expect(brainTier()).toEqual(['brain-high', 'brain-low']);
    expect(
      orderByTier(['worker-local', 'brain-low', 'brain-high'], 'brain'),
    ).toEqual(['brain-high', 'brain-low', 'worker-local']);
  });
});

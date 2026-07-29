import { describe, expect, it } from 'vitest';
import { BRAIN_TIER, classifyTier, orderByTier } from './tier-policy.js';

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

  it('prioritizes the independently verified brain providers before unstable fallbacks', () => {
    expect(BRAIN_TIER.slice(0, 4)).toEqual([
      'claude-code',
      'codex',
      'cursor-agent',
      'opencode',
    ]);
    expect(
      orderByTier(['opencode', 'cursor-agent', 'codex', 'claude-code'], 'brain'),
    ).toEqual(['claude-code', 'codex', 'cursor-agent', 'opencode']);
  });
});

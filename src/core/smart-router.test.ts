import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listEnabledIds, getAgentState, dbGet } = vi.hoisted(() => ({
  listEnabledIds: vi.fn(() => ['openrouter', 'ollama', 'vllm', 'claude-code', 'unknown-provider']),
  getAgentState: vi.fn(async (id: string) => {
    if (id === 'vllm') {
      return { health: { circuitState: 'open' } };
    }
    return { health: { circuitState: 'closed' } };
  }),
  dbGet: vi.fn((agentId: string) => {
    // Active rate limit: SQL filters is_limited=1 AND reset_at > datetime('now')
    if (agentId === 'openrouter') {
      return { active: 1 };
    }
    return null;
  }),
}));

vi.mock('../agent/agent-manager.js', () => ({
  agentManager: {
    listEnabledIds,
  },
}));

vi.mock('./shared-state.js', () => ({
  sharedState: {
    getAgentState,
  },
}));

vi.mock('../storage/database.js', () => ({
  getDb: () => ({
    prepare: () => ({ get: dbGet }),
  }),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  isTaskCompatibleProvider,
  ProviderSelectionError,
  smartRouter,
  sortProvidersByCostOrder,
} from './smart-router.js';

describe('SmartRouter', () => {
  beforeEach(() => {
    listEnabledIds.mockClear();
    getAgentState.mockClear();
    dbGet.mockReset();
    dbGet.mockImplementation((agentId: string) => {
      if (agentId === 'openrouter') {
        return { active: 1 };
      }
      return null;
    });
  });

  describe('sortProvidersByCostOrder', () => {
    it('sorts providers based on cost order', () => {
      const input = ['openrouter', 'ollama', 'claude-code', 'aider'];
      const expected = ['ollama', 'openrouter', 'aider', 'claude-code'];
      expect(sortProvidersByCostOrder(input)).toEqual(expected);
    });

    it('places unknown providers at the end', () => {
      const input = ['unknown1', 'ollama', 'unknown2', 'vllm'];
      const sorted = sortProvidersByCostOrder(input);
      expect(sorted[0]).toBe('ollama');
      expect(sorted[1]).toBe('vllm');
      expect(sorted.slice(2)).toContain('unknown1');
      expect(sorted.slice(2)).toContain('unknown2');
    });

    it('handles empty arrays', () => {
      expect(sortProvidersByCostOrder([])).toEqual([]);
    });
  });

  describe('analyzeComplexity', () => {
    it('scores short plain text lower', () => {
      const score = smartRouter.analyzeComplexity('hello');
      expect(score).toBeLessThanOrEqual(5);
    });

    it('scores long text with code and technical keywords higher', () => {
      const prompt = 'Implement a security feature for our database migration. We need to refactor the authentication workflow.\n```typescript\nconst auth = true;\n```\n1. First step\n2. Second step\n3. Third step\n4. Fourth step\n5. Fifth step';
      const score = smartRouter.analyzeComplexity(prompt);
      expect(score).toBeGreaterThan(5);
    });
  });

  describe('selectMode', () => {
    it('triggers discussion mode for design keywords', () => {
      expect(smartRouter.selectMode('시스템 설계 및 아키텍처 토론', 5)).toBe('discussion');
    });

    it('triggers parallel mode for security/test keywords', () => {
      expect(smartRouter.selectMode('보안 취약점 및 테스트 코드 작성', 5)).toBe('parallel');
    });

    it('uses complexity-based routing if no keywords match', () => {
      expect(smartRouter.selectMode('간단한 질문', 2)).toBe('task');
      expect(smartRouter.selectMode('어려운 질문', 7)).toBe('discussion');
      expect(smartRouter.selectMode('아주 복잡한 시스템 요청', 10)).toBe('hive');
    });
  });

  describe('selectProviders', () => {
    it('filters out rate-limited or circuit-broken providers and sorts by cost', async () => {
      // Available providers from mock: ['openrouter', 'ollama', 'vllm', 'claude-code', 'unknown-provider']
      // openrouter: actively rate-limited (reset_at still in the future → SQL match)
      // vllm: circuit-broken (sharedState returning circuitState: 'open')
      // Available for routing should be: ['ollama', 'claude-code', 'unknown-provider']
      // Sorted by cost order: ['ollama', 'claude-code', 'unknown-provider']
      
      const providers = await smartRouter.selectProviders('task', 3);
      expect(providers).toEqual(['ollama', 'claude-code', 'unknown-provider']);
    });

    it('does not exclude providers when rate_limit_state row has expired', async () => {
      // Expired row: is_limited may still be 1, but reset_at <= now → SQL returns no row
      dbGet.mockImplementation(() => null);

      const providers = await smartRouter.selectProviders('task', 5);
      expect(providers).toContain('openrouter');
      expect(providers[0]).toBe('ollama');
      expect(providers).toContain('claude-code');
      // vllm still circuit-open
      expect(providers).not.toContain('vllm');
    });

    it('does not exclude providers when rate_limit_state row has no reset_at (null)', async () => {
      // Missing reset_at (NULL): reset_at > now is false → SQL returns no row
      dbGet.mockImplementation(() => null);

      const providers = await smartRouter.selectProviders('task', 5);
      expect(providers).toContain('openrouter');
      expect(providers[0]).toBe('ollama');
    });

    it('fails explicitly when available providers do not meet the mode minimum', async () => {
      // openrouter is rate-limited, vllm is circuit-open → only ollama remains (1 < discussion minimum 3)
      listEnabledIds.mockReturnValueOnce(['openrouter', 'vllm', 'ollama']);
      await expect(smartRouter.selectProviders('discussion', 3)).rejects.toBeInstanceOf(ProviderSelectionError);
    });
  });

  describe('provider capability gate', () => {
    it('keeps media UUID providers out of code and verification work', () => {
      expect(isTaskCompatibleProvider('higgsfield', 'code')).toBe(false);
      expect(isTaskCompatibleProvider('higgsfield', 'verify')).toBe(false);
      expect(isTaskCompatibleProvider('higgsfield', 'media')).toBe(true);
      expect(isTaskCompatibleProvider('codex', 'code')).toBe(true);
    });
  });

  describe('dispatch', () => {
    it('dispatches simple prompt to optimal provider', async () => {
      const decision = await smartRouter.dispatch('간단한 테스트');
      // '테스트' keyword triggers 'parallel' mode, which requests 3 providers.
      // Available: 'ollama', 'claude-code', 'unknown-provider'
      expect(decision.mode).toBe('parallel');
      expect(decision.providers).toEqual(['ollama', 'claude-code', 'unknown-provider']);
    });
  });

  describe('inferTaskType', () => {
    it('classifies implementation with vitest as code, not pure verification', () => {
      expect(smartRouter.inferTaskType('TypeScript 버그를 수정하고 vitest를 실행하라')).toBe('code');
      expect(smartRouter.inferTaskType('기존 결과를 검증만 하라')).toBe('verify');
    });
  });
});

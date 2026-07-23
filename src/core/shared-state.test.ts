import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisState = vi.hoisted(() => ({
  connected: false,
  getRedis: vi.fn(),
}));

vi.mock('../storage/redis.js', () => ({
  getRedis: redisState.getRedis,
  isRedisConnected: () => redisState.connected,
}));
vi.mock('../storage/database.js', () => ({ getDb: vi.fn() }));
vi.mock('../utils/config.js', () => ({
  env: { NODE_ENV: 'test' },
  loadEnabledProviders: vi.fn(() => []),
}));

import { SharedState } from './shared-state.js';

describe('SharedState Redis fallback', () => {
  beforeEach(() => {
    redisState.connected = false;
    redisState.getRedis.mockReset();
  });

  it('keeps partial state updates in memory without touching Redis', async () => {
    const state = new SharedState();

    await state.setAgentState('codex', { status: 'working', messageCount: 2 });

    expect(await state.getAgentState('codex')).toMatchObject({
      id: 'codex',
      status: 'working',
      currentTask: null,
      messageCount: 2,
    });
    expect(redisState.getRedis).not.toHaveBeenCalled();
  });

  it('keeps local state and ignores an exhausted optimistic Redis conflict', async () => {
    const transactionRedis = {
      watch: vi.fn(async () => 'OK'),
      unwatch: vi.fn(async () => 'OK'),
      get: vi.fn(async () => null),
      multi: vi.fn(() => {
        const multi = {
          set: vi.fn(() => multi),
          exec: vi.fn(async () => null),
        };
        return multi;
      }),
      disconnect: vi.fn(),
    };
    const redis = {
      duplicate: vi.fn(() => transactionRedis),
      get: vi.fn(async () => null),
    };
    redisState.connected = true;
    redisState.getRedis.mockResolvedValue(redis);
    const state = new SharedState();

    await expect(state.setAgentState('codex', { status: 'idle' })).resolves.toBeUndefined();

    expect(await state.getAgentState('codex')).toMatchObject({ id: 'codex', status: 'idle' });
    expect(transactionRedis.watch).toHaveBeenCalledTimes(9);
  });
});

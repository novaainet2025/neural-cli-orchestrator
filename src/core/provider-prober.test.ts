import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  probeProvider,
  listEnabledIds,
  listSnapshots,
  reset,
  getProvider,
} = vi.hoisted(() => ({
  probeProvider: vi.fn(),
  listEnabledIds: vi.fn(() => ['openrouter']),
  listSnapshots: vi.fn(),
  reset: vi.fn(),
  // 백오프 분기용: 무료 프로바이더(cost!=='paid')는 첫 사이클에 즉시 프로브된다.
  getProvider: vi.fn(() => ({ cost: 'free' })),
}));

vi.mock('../agent/agent-manager.js', () => ({
  agentManager: { listEnabledIds, probeProvider, getProvider },
}));

vi.mock('../security/circuit-breaker-registry.js', () => ({
  circuitBreakerRegistry: { listSnapshots, reset },
}));

vi.mock('../storage/redis.js', () => ({
  getRedis: vi.fn(),
  isRedisConnected: vi.fn(() => false),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { ProviderProber } from './provider-prober.js';

describe('ProviderProber', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    listEnabledIds.mockReturnValue(['openrouter']);
    probeProvider.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resets an open circuit after a successful probe', async () => {
    listSnapshots.mockReturnValue([{
      agentId: 'openrouter',
      state: 'open',
      reason: 'quota',
    }]);
    const prober = new ProviderProber();

    prober.start(100);
    await vi.advanceTimersByTimeAsync(100);
    prober.stop();

    expect(listSnapshots).toHaveBeenCalledWith(['openrouter']);
    expect(probeProvider).toHaveBeenCalledWith('openrouter', 'PING', 30_000);
    expect(reset).toHaveBeenCalledWith('openrouter');
  });

  it('does not probe an open circuit caused by auth', async () => {
    listSnapshots.mockReturnValue([{
      agentId: 'openrouter',
      state: 'open',
      reason: 'auth',
    }]);
    const prober = new ProviderProber();

    prober.start(100);
    await vi.advanceTimersByTimeAsync(100);
    prober.stop();

    expect(probeProvider).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it('keeps the existing circuit state after a failed probe', async () => {
    listSnapshots.mockReturnValue([{
      agentId: 'openrouter',
      state: 'open',
      reason: 'rate-limit',
    }]);
    probeProvider.mockResolvedValue(false);
    const prober = new ProviderProber();

    prober.start(100);
    await vi.advanceTimersByTimeAsync(100);
    prober.stop();

    expect(probeProvider).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
  });
});

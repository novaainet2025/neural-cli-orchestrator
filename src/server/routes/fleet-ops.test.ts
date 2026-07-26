import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eventOn: vi.fn(),
  eventOff: vi.fn(),
}));

vi.mock('../../agent/agent-manager.js', () => ({
  agentManager: {
    listProviders: vi.fn(() => []),
  },
}));

vi.mock('../../security/circuit-breaker-registry.js', () => ({
  circuitBreakerRegistry: {},
}));

vi.mock('../../core/event-bus.js', () => ({
  eventBus: {
    on: mocks.eventOn,
    off: mocks.eventOff,
    publish: vi.fn(),
  },
}));

vi.mock('../../core/shared-state.js', () => ({
  sharedState: {
    getAllAgentStates: vi.fn(async () => ({})),
  },
}));

vi.mock('../../storage/database.js', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      run: vi.fn(),
    })),
  })),
}));

import { registerFleetOpsRoutes } from './fleet-ops.js';

describe('registerFleetOpsRoutes resource cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('FLEET_CENTRAL_URL', 'http://fleet-central.test');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ activities: {} }),
    })));
    mocks.eventOn.mockClear();
    mocks.eventOff.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('clears push timers and removes event listeners when Fastify closes', async () => {
    const closeHooks: Array<() => Promise<void>> = [];
    const app = {
      get: vi.fn(),
      post: vi.fn(),
      addHook: vi.fn((name: string, hook: () => Promise<void>) => {
        if (name === 'onClose') closeHooks.push(hook);
      }),
    } as unknown as FastifyInstance;

    await registerFleetOpsRoutes(app);

    const createdHandler = mocks.eventOn.mock.calls.find(
      ([eventType]) => eventType === 'task:created',
    )?.[1] as (() => void) | undefined;
    expect(createdHandler).toBeTypeOf('function');
    const initialTimerCount = vi.getTimerCount();
    expect(initialTimerCount).toBeGreaterThanOrEqual(1);

    createdHandler?.();
    expect(vi.getTimerCount()).toBe(initialTimerCount + 1);

    expect(closeHooks).toHaveLength(1);
    await closeHooks[0]();
    await vi.runAllTicks();

    const fetchCallsAfterClose = vi.mocked(fetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetchCallsAfterClose);
    for (const eventType of ['task:created', 'task:completed', 'task:failed']) {
      const handler = mocks.eventOn.mock.calls.find(([type]) => type === eventType)?.[1];
      expect(mocks.eventOff).toHaveBeenCalledWith(eventType, handler);
    }
  });
});

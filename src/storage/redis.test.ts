import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisInstances } = vi.hoisted(() => ({ redisInstances: [] as any[] }));

vi.mock('ioredis', () => {
  class Redis {
    private listeners = new Map<string, Array<(...args: any[]) => void>>();

    constructor() {
      redisInstances.push(this);
    }

    on(event: string, listener: (...args: any[]) => void): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: any[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }

    async connect(): Promise<void> {
      this.emit('connect');
    }

    disconnect(): void {
      this.emit('close');
    }

    async ping(): Promise<string> {
      return 'PONG';
    }
  }

  return { Redis };
});

vi.mock('../utils/config.js', () => ({ env: { REDIS_URL: 'redis://test' } }));
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { closeRedis, getRedis, getSubscriber, isRedisConnected } from './redis.js';

describe('Redis connection state', () => {
  beforeEach(async () => {
    await closeRedis();
    redisInstances.length = 0;
  });

  it('reports only the main connection state', async () => {
    await getRedis();
    await getSubscriber();
    expect(isRedisConnected()).toBe(true);

    redisInstances[1].emit('error', new Error('subscriber unavailable'));
    expect(isRedisConnected()).toBe(true);

    redisInstances[0].emit('error', new Error('main unavailable'));
    expect(isRedisConnected()).toBe(false);
  });
});

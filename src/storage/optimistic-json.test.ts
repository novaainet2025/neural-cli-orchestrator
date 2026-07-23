import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { OptimisticUpdateConflictError, updateJsonWithWatch } from './optimistic-json.js';

interface StoredValue {
  status: string;
  messageCount: number;
}

function createRedisDouble(
  initial: StoredValue,
  execOutcomes: Array<'ok' | 'conflict'>,
  onConflict?: (store: Map<string, string>) => void,
) {
  const key = 'nco:test:state';
  const store = new Map([[key, JSON.stringify(initial)]]);
  let pending: { key: string; value: string; ttl: number } | null = null;

  const transactionRedis = {
    watch: vi.fn(async () => 'OK'),
    unwatch: vi.fn(async () => 'OK'),
    get: vi.fn(async (target: string) => store.get(target) ?? null),
    set: vi.fn(async (target: string, value: string, _ex: string, _ttl: number) => {
      store.set(target, value);
      return 'OK';
    }),
    multi: vi.fn(() => {
      const multi = {
        set: vi.fn((target: string, value: string, _ex: string, ttl: number) => {
          pending = { key: target, value, ttl };
          return multi;
        }),
        exec: vi.fn(async () => {
          const outcome = execOutcomes.shift() ?? 'ok';
          if (outcome === 'conflict') {
            onConflict?.(store);
            return null;
          }
          if (pending) store.set(pending.key, pending.value);
          return [['OK', 'OK']];
        }),
      };
      return multi;
    }),
    disconnect: vi.fn(),
  };
  const redis = { duplicate: vi.fn(() => transactionRedis) } as unknown as Redis;

  return { key, store, redis, transactionRedis, getPending: () => pending };
}

describe('updateJsonWithWatch', () => {
  it('retries a conflicted JSON blob update and preserves the concurrent change', async () => {
    const fake = createRedisDouble(
      { status: 'idle', messageCount: 0 },
      ['conflict', 'ok'],
      store => store.set(fake.key, JSON.stringify({ status: 'idle', messageCount: 1 })),
    );

    const result = await updateJsonWithWatch<StoredValue>(
      fake.redis,
      fake.key,
      current => ({ ...current!, status: 'working' }),
      { ttlSeconds: 600, operation: 'testUpdate' },
    );

    expect(result).toEqual({ status: 'working', messageCount: 1 });
    expect(JSON.parse(fake.store.get(fake.key)!)).toEqual(result);
    expect(fake.transactionRedis.watch).toHaveBeenCalledTimes(2);
    expect(fake.getPending()).toMatchObject({ key: fake.key, ttl: 600 });
  });

  it('uses one final guarded attempt after the configured retry limit', async () => {
    const fake = createRedisDouble(
      { status: 'idle', messageCount: 0 },
      ['conflict', 'conflict', 'ok'],
    );

    const result = await updateJsonWithWatch<StoredValue>(
      fake.redis,
      fake.key,
      current => ({ ...current!, status: 'working' }),
      { ttlSeconds: 600, operation: 'testFallback', maxAttempts: 2 },
    );

    expect(result?.status).toBe('working');
    expect(fake.transactionRedis.watch).toHaveBeenCalledTimes(3);
    expect(fake.transactionRedis.set).not.toHaveBeenCalled();
    expect(fake.store.get(fake.key)).toBe(JSON.stringify(result));
  });

  it('throws a typed conflict without a blind SET when the final guard conflicts', async () => {
    const initial = { status: 'idle', messageCount: 0 };
    const fake = createRedisDouble(initial, ['conflict', 'conflict', 'conflict']);

    const update = updateJsonWithWatch<StoredValue>(
      fake.redis,
      fake.key,
      current => ({ ...current!, status: 'working' }),
      { ttlSeconds: 600, operation: 'testConflict', maxAttempts: 2 },
    );

    await expect(update).rejects.toMatchObject({
      name: 'OptimisticUpdateConflictError',
      key: fake.key,
      operation: 'testConflict',
      attempts: 3,
    } satisfies Partial<OptimisticUpdateConflictError>);
    expect(fake.transactionRedis.watch).toHaveBeenCalledTimes(3);
    expect(fake.transactionRedis.set).not.toHaveBeenCalled();
    expect(JSON.parse(fake.store.get(fake.key)!)).toEqual(initial);
  });
});

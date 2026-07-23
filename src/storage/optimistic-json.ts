import type { Redis } from 'ioredis';
import { createLogger } from '../utils/logger.js';

const log = createLogger('optimistic-json');
const DEFAULT_MAX_ATTEMPTS = 8;

export class OptimisticUpdateConflictError extends Error {
  constructor(
    readonly key: string,
    readonly operation: string,
    readonly attempts: number,
  ) {
    super(`Optimistic update conflict for ${operation} after ${attempts} guarded attempts`);
    this.name = 'OptimisticUpdateConflictError';
  }
}

export interface OptimisticJsonOptions<T> {
  ttlSeconds: number | ((value: T) => number);
  operation: string;
  maxAttempts?: number;
}

/**
 * Atomically update a JSON blob with Redis WATCH/MULTI optimistic locking.
 * A dedicated connection is required because WATCH state belongs to a connection.
 */
export async function updateJsonWithWatch<T>(
  redis: Redis,
  key: string,
  update: (current: T | null) => T | null,
  options: OptimisticJsonOptions<T>,
): Promise<T | null> {
  const transactionRedis = redis.duplicate();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const ttlFor = (value: T): number =>
    typeof options.ttlSeconds === 'function' ? options.ttlSeconds(value) : options.ttlSeconds;
  const attemptUpdate = async (): Promise<{ conflicted: boolean; value: T | null }> => {
    await transactionRedis.watch(key);
    const raw = await transactionRedis.get(key);
    const next = update(raw === null ? null : JSON.parse(raw) as T);

    if (next === null) {
      await transactionRedis.unwatch();
      return { conflicted: false, value: null };
    }

    const result = await transactionRedis
      .multi()
      .set(key, JSON.stringify(next), 'EX', ttlFor(next))
      .exec();

    return result === null
      ? { conflicted: true, value: null }
      : { conflicted: false, value: next };
  };

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await attemptUpdate();
      if (!result.conflicted) return result.value;
    }

    log.warn(
      { key, operation: options.operation, attempts: maxAttempts },
      'Optimistic update retries exhausted; attempting final guarded update',
    );

    const finalResult = await attemptUpdate();
    if (!finalResult.conflicted) return finalResult.value;

    throw new OptimisticUpdateConflictError(key, options.operation, maxAttempts + 1);
  } finally {
    transactionRedis.disconnect();
  }
}

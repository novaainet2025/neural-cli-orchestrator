import { Redis } from 'ioredis';
import { env } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('redis');

let client: Redis | null = null;
let subscriber: Redis | null = null;
let connected = false;

function createClient(name: string): Redis {
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      if (times > 10) return null;
      return Math.min(times * 200, 5000);
    },
    lazyConnect: true,
  });

  redis.on('connect', () => {
    connected = true;
    log.info({ name }, 'Redis connected');
  });

  redis.on('error', (err: Error) => {
    connected = false;
    log.error({ name, err: err.message }, 'Redis error');
  });

  redis.on('close', () => {
    connected = false;
    log.warn({ name }, 'Redis disconnected');
  });

  return redis;
}

export async function getRedis(): Promise<Redis> {
  if (!client) {
    client = createClient('main');
    await client.connect();
  }
  return client;
}

export async function getSubscriber(): Promise<Redis> {
  if (!subscriber) {
    subscriber = createClient('subscriber');
    await subscriber.connect();
  }
  return subscriber;
}

export function isRedisConnected(): boolean {
  return connected;
}

export async function closeRedis(): Promise<void> {
  if (subscriber) {
    subscriber.disconnect();
    subscriber = null;
  }
  if (client) {
    client.disconnect();
    client = null;
  }
  connected = false;
  log.info('Redis connections closed');
}

// ─── Health Check ─────────────────────────────────────
export async function redisHealthCheck(): Promise<boolean> {
  try {
    const redis = await getRedis();
    const result = await redis.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}

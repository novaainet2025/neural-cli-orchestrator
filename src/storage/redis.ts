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
    // 2026-07-02 kangnote 0/11 사건 수정: 기존에는 10회 후 null 반환 → ioredis가
    // 영구 포기해, 부팅 시 Redis가 죽어있으면 이후 살려도 재연결 불가(하트비트
    // 전멸 → 전 에이전트 offline 표시). 무한 재시도(10초 캡)로 자가 회복.
    retryStrategy(times: number) {
      return Math.min(times * 200, 10_000);
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
    const nextClient = createClient('main');
    try {
      await nextClient.connect();
      client = nextClient;
    } catch (error) {
      client = null;
      throw error;
    }
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

import { FastifyPluginAsync } from 'fastify';
import { createLogger } from '../../utils/logger.js';

interface RateInfo {
  count: number; // request count in current window
  reset: number; // timestamp when window resets (ms)
}

const log = createLogger('ip-rate-limit');

/**
 * Simple sliding window rate limiter per IP.
 * `max` requests per `windowMs`.
 * Returns HTTP 429 when limit exceeded.
 */
export const ipRateLimit: FastifyPluginAsync<{ max: number; windowMs: number }> = async (app, opts) => {
  const { max, windowMs } = opts;
  const store = new Map<string, RateInfo>();

  // Cleanup expired entries based on reset time
  const cleanup = () => {
    const now = Date.now();
    for (const [ip, info] of store.entries()) {
      if (now >= info.reset) {
        store.delete(ip);
      }
    }
  };

  // Periodic cleanup to avoid memory leak
  const interval = setInterval(cleanup, windowMs);
  // Ensure cleanup on close
  app.addHook('onClose', async () => clearInterval(interval));

  app.addHook('onRequest', async (request, reply) => {
    if (store.size > 50000) {
      store.clear();
    }
    const ip = request.ip || 'unknown';
    const now = Date.now();
    let info = store.get(ip);
    if (!info || now >= info.reset) {
      // initialize or reset window
      info = { count: 0, reset: now + windowMs };
    }
    if (info.count >= max) {
      log.warn({ ip, max, windowMs }, 'Rate limit exceeded');
      reply.code(429).send({ error: 'Too Many Requests', retryAfter: Math.ceil((info.reset - now) / 1000) });
      return reply;
    }
    info.count++;
    store.set(ip, info);
  });
};

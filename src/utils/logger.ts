import pino from 'pino';
import { env } from './config.js';

// API 키 패턴 마스킹
const redactPaths = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
];

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
    },
  } : undefined,
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
});

export function createLogger(name: string) {
  return logger.child({ module: name });
}

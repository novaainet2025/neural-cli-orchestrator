import pino from 'pino';
import { env } from './config.js';

// API 키 패턴 마스킹
const redactPaths = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
];

const loggerOptions = {
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
};

export const logger = env.NODE_ENV === 'production'
  ? pino(loggerOptions, pino.destination(2))
  : pino({
      ...loggerOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          destination: 2,
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
    });

export function createLogger(name: string) {
  return logger.child({ module: name });
}

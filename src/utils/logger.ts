import pino from 'pino';
import { createFileLogger } from './file-logger.js';

/**
 * Root logger singleton — created once.
 *
 * pino.transport() (worker thread + sonic-boom) was causing
 * "sonic boom is not ready yet" crash during process.exit().
 * Fix: use synchronous stdout stream + pretty-print manually,
 * so no worker thread is spawned and on-exit-leak-free has
 * nothing async to flush.
 */
let _root: pino.Logger | null = null;

function getRootLogger(): pino.Logger {
  if (_root) return _root;

  const fileStream = createFileLogger('nco');

  // Use pino-pretty as a synchronous Transform piped into process.stdout
  // This avoids the worker thread that causes the sonic-boom exit crash.
  let prettyStream: pino.DestinationStream;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pinoPretty = require('pino-pretty');
    prettyStream = pinoPretty({
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname,module',
      sync: true,  // critical: no worker thread
      destination: process.stdout,
    });
  } catch {
    // Fallback: plain stdout (always sync)
    prettyStream = process.stdout as unknown as pino.DestinationStream;
  }

  const streams = pino.multistream([
    { stream: prettyStream },
    { stream: fileStream },
  ]);

  _root = pino({
    level: process.env.LOG_LEVEL || 'info',
    redact: {
      paths: ['req.headers.authorization', 'req.headers["x-api-key"]'],
      censor: '[REDACTED]',
    },
  }, streams);

  return _root;
}

/**
 * Returns a child logger bound with {module: name}.
 * Uses a single shared transport — no additional exit listeners added per call.
 */
export function createLogger(name: string): pino.Logger {
  return getRootLogger().child({ module: name });
}

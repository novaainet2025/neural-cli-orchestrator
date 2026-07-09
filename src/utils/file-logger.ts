import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = process.env.LOG_DIR || 'logs';

/**
 * Creates a pino stream that writes to a daily rotating log file.
 * Files are named: logs/<name>-YYYY-MM-DD.log
 *
 * @param name - Module name used as prefix for the log file.
 * @returns pino-compatible writable stream.
 */
export function createFileLogger(name: string): pino.DestinationStream {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  let activeDate = '';
  let destination: pino.DestinationStream | null = null;

  const getDestination = (): pino.DestinationStream => {
    const nextDate = new Date().toISOString().slice(0, 10);
    if (destination && activeDate === nextDate) {
      return destination;
    }

    activeDate = nextDate;
    const filePath = path.join(LOG_DIR, `${name}-${activeDate}.log`);
    destination = pino.destination({ dest: filePath, sync: true, append: true });
    return destination;
  };

  return {
    write(msg: string): void {
      getDestination().write(msg);
    },
  };
}

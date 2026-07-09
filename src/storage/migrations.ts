import { closeDb, runMigrations } from './database.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('migrations');

function main(): void {
  try {
    runMigrations();
    log.info('Migrations finished');
  } catch (err) {
    log.fatal({ err }, 'Migration run failed');
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

main();

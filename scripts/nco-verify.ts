import { getDb } from '../src/storage/database.js';
import { createLogger } from '../src/utils/logger.js';
import { execa } from 'execa';

const log = createLogger('nco-verify');

async function main() {
  log.info('Starting NCO System Verification...');
  let hasError = false;

  // 1. Check Database Tables
  try {
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNames = tables.map(t => t.name);
    
    const requiredTables = ['tasks', 'metrics', 'false_reports', 'agents'];
    for (const table of requiredTables) {
      if (!tableNames.includes(table)) {
        log.error({ table }, 'Missing required table');
        hasError = true;
      }
    }
    log.info('Database tables verified.');
  } catch (err: any) {
    log.error({ err: err.message }, 'Database verification failed');
    hasError = true;
  }

  // 2. Check TypeScript Compilation
  try {
    log.info('Running TypeScript type check...');
    await execa('npx', ['tsc', '--noEmit'], { timeout: 60000 });
    log.info('TypeScript check passed.');
  } catch (err: any) {
    log.error('TypeScript check failed. Please run npx tsc --noEmit to see errors.');
    hasError = true;
  }

  // 3. Report Recent False Reports
  try {
    const db = getDb();
    const recentFailures = db.prepare(`
      SELECT task_id, agent_id, reason, created_at 
      FROM false_reports 
      ORDER BY created_at DESC 
      LIMIT 5
    `).all() as any[];

    if (recentFailures.length > 0) {
      log.warn({ count: recentFailures.length }, 'Recent false reports detected:');
      recentFailures.forEach(f => {
        log.warn(`  - Task: ${f.task_id} | Agent: ${f.agent_id} | Reason: ${f.reason} | Date: ${f.created_at}`);
      });
    } else {
      log.info('No recent false reports found.');
    }
  } catch (err: any) {
    log.error({ err: err.message }, 'Failed to query false reports');
  }

  // 4. Check Agent Connectivity (Optional/Basic)
  log.info('System verification complete.');
  
  if (hasError) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

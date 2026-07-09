import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getDb } from '../src/storage/database.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('nco-check-false-reports');

async function main() {
  log.info('Running False Report Verification...');
  let hasError = false;

  const fixMode = process.argv.includes('--fix');

  const db = getDb();
  
  // 1. Get actual false report count from DB
  const falseReportsRow = db.prepare('SELECT COUNT(*) as count FROM false_reports').get() as { count: number } | undefined;
  const actualDbCount = falseReportsRow?.count ?? 0;
  log.info(`Actual False Reports in Database: ${actualDbCount}`);

  // 2. Verify metrics table is in sync
  const metricRow = db.prepare("SELECT value FROM metrics WHERE agent_id = 'system' AND metric_type = 'false_report_count'").get() as { value: number } | undefined;
  const metricCount = metricRow?.value ?? 0;

  if (metricCount !== actualDbCount) {
    log.warn(`Metrics table count (${metricCount}) is out of sync with false_reports count (${actualDbCount}). Syncing...`);
    db.prepare(`
      UPDATE metrics 
      SET value = ? 
      WHERE agent_id = 'system' AND metric_type = 'false_report_count'
    `).run(actualDbCount);
    log.info('Metrics table successfully synchronized.');
  }

  // 3. Scan and check markdown files
  const filesToCheck = [
    resolve('../ImprovementPlan.md'),
    resolve('ImprovementPlan.md'),
    resolve('ImprovementNotes.md'),
  ];

  for (const filePath of filesToCheck) {
    if (!existsSync(filePath)) {
      continue;
    }

    let content = readFileSync(filePath, 'utf-8');
    let originalContent = content;

    // Regex patterns for current false report count statements
    // 1) "False report count: X"
    // 2) "거짓 보고 X건"
    // 3) "false_report_count가 X회"
    const patterns = [
      { regex: /((?:`?\*?\*?False report count\*?\*?`?)\s*:\s*)(\d+)/gi, label: 'False report count' },
      { regex: /((?:`?\*?\*?거짓\s*보고\*?\*?`?\s*))(\d+)(건)/g, label: '거짓 보고 건수' },
      { regex: /((?:`?false_report_count`?|false report count)\s*가\s*)(\d+)(회)/gi, label: 'false_report_count' }
    ];

    let fileUpdated = false;

    for (const pattern of patterns) {
      let match;
      // Reset regex index
      pattern.regex.lastIndex = 0;
      while ((match = pattern.regex.exec(content)) !== null) {
        const foundCount = parseInt(match[2], 10);
        if (foundCount !== actualDbCount) {
          if (fixMode) {
            log.info(`Fixing pattern "${pattern.label}" in ${filePath}: ${foundCount} -> ${actualDbCount}`);
            // Replace the count
            content = content.replace(match[0], match[1] + actualDbCount + (match[3] || ''));
            fileUpdated = true;
          } else {
            log.error(`Mismatch in ${filePath}: Stated ${pattern.label} is ${foundCount}, but DB contains ${actualDbCount}.`);
            hasError = true;
          }
        }
      }
    }

    if (fileUpdated && fixMode) {
      writeFileSync(filePath, content, 'utf-8');
      log.info(`Updated ${filePath} to match actual DB state.`);
    }
  }

  if (hasError) {
    log.error('False Report verification failed due to mismatch. Please run "npm run lint-false-report -- --fix" or update files manually.');
    process.exit(1);
  } else {
    log.info('False Report verification passed successfully.');
  }
}

main().catch(err => {
  log.error({ err: err.message }, 'Unexpected error in verification script');
  process.exit(1);
});

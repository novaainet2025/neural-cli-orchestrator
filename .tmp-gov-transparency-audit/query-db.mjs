import { execSync } from 'node:child_process';
const db = '/Users/nova-ai/project/nova-ax/db/nova-ax.db';
const companyId = 'org_nco-government';
const teamId = 'team_gov-government-transparency';

const q = (sql) => execSync(`sqlite3 ${db} "${sql}"`, { encoding: 'utf8' });

console.log('=== HEALTH ===');
console.log(execSync('curl -s http://localhost:6300/api/health | head -c 300', { encoding: 'utf8' }));

console.log('\n=== verification_directives ===');
console.log(q(`SELECT id, task_id, type, status, work_report_id, dispatched_at, created_at FROM verification_directives WHERE company_id='${companyId}' AND team_id='${teamId}';`));

console.log('\n=== verification_runs (LIMIT 5) ===');
console.log(q(`SELECT id, task_id, status, passed_institutions, created_at FROM verification_runs WHERE company_id='${companyId}' AND team_id='${teamId}' ORDER BY created_at DESC LIMIT 5;`));

console.log('\n=== verification_receipts ===');
console.log(q(`SELECT id, run_id, task_id, issued_at FROM verification_receipts WHERE company_id='${companyId}' AND team_id='${teamId}' ORDER BY issued_at DESC LIMIT 5;`));

console.log('\n=== verification_receipt_consumptions ===');
console.log(q(`SELECT receipt_id, consumed_at FROM verification_receipt_consumptions WHERE receipt_id IN (SELECT id FROM verification_receipts WHERE company_id='${companyId}' AND team_id='${teamId}');`));

console.log('\n=== verification_loops (active) ===');
console.log(q(`SELECT id, status, current_iteration, original_run_id FROM verification_loops WHERE company_id='${companyId}' AND team_id='${teamId}' AND status IN ('action_required','resubmitted');`));

console.log('\n=== verification_scopes ===');
console.log(q(`SELECT * FROM verification_scopes WHERE company_id='${companyId}' AND team_id='${teamId}';`));

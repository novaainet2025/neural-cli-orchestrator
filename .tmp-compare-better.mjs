import Database from 'better-sqlite3';
import fs from 'fs';

const dbPath = '/Users/nova-ai/project/nco/db/nco.db';
const filePath = '/Users/nova-ai/project/nco/data/team-runner/team_research-visualization-2026-07-30.md';
const taskId = 'task_FIeI336uBZOo2b42';

const db = new Database(dbPath, { readonly: true });
const row = db.prepare(
  "SELECT id, status, length(response) as len, substr(response,1,200) as response_start, substr(response,-200) as response_end, response FROM tasks WHERE id = ?"
).get(taskId);

console.log('=== SQLITE QUERY ===');
console.log(`${row.id}|${row.status}|${row.len}|${row.response_start}|${row.response_end}`);

const stat = fs.statSync(filePath);
console.log('=== WC ===');
console.log(`    ${stat.size} ${filePath}`);

const file = fs.readFileSync(filePath, 'utf8');
const resp = row.response;
console.log('=== NODE COMPARE ===');
console.log('fileLen', file.length, 'respLen', resp.length);
console.log('endsWith', file.endsWith(resp));
console.log('fileEnd', JSON.stringify(file.slice(-100)));
console.log('respEnd', JSON.stringify(resp.slice(-100)));
console.log('fileStart', JSON.stringify(file.slice(0, 100)));
console.log('respStart', JSON.stringify(resp.slice(0, 100)));

db.close();

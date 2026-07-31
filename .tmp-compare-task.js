const fs = require('fs');
const { spawnSync } = require('child_process');

const dbPath = '/Users/nova-ai/project/nco/db/nco.db';
const filePath = '/Users/nova-ai/project/nco/data/team-runner/team_research-visualization-2026-07-30.md';
const taskId = 'task_FIeI336uBZOo2b42';

const q1 = spawnSync('sqlite3', [dbPath, `SELECT id, status, length(response), substr(response,1,200) as response_start, substr(response,-200) as response_end FROM tasks WHERE id='${taskId}';`], { encoding: 'utf8' });
console.log('=== SQLITE QUERY ===');
console.log(q1.stdout);
if (q1.stderr) console.error(q1.stderr);

const wc = spawnSync('wc', ['-c', filePath], { encoding: 'utf8' });
console.log('=== WC ===');
console.log(wc.stdout.trim());

const file = fs.readFileSync(filePath, 'utf8');
const r = spawnSync('sqlite3', ['-json', dbPath, `SELECT response FROM tasks WHERE id="${taskId}"`], { encoding: 'utf8' });
const resp = JSON.parse(r.stdout)[0].response;
console.log('=== NODE COMPARE ===');
console.log('fileLen', file.length, 'respLen', resp.length);
console.log('endsWith', file.endsWith(resp));
console.log('fileEnd', JSON.stringify(file.slice(-100)));
console.log('respEnd', JSON.stringify(resp.slice(-100)));
console.log('fileStart', JSON.stringify(file.slice(0, 100)));
console.log('respStart', JSON.stringify(resp.slice(0, 100)));

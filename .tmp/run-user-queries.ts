import { computeTeamScores } from '../src/core/team-scorer.js';
import Database from 'better-sqlite3';
import { resolve } from 'path';

const DB = resolve(import.meta.dirname, '../db/nco.db');

console.log('=== COMMAND 1 ===');
const t = computeTeamScores().find((r) => r.teamId === 'team_gov-engineering-reliability');
console.log('TEAM_SCORE:', JSON.stringify(t));
const all = computeTeamScores();
const zero = all.filter((r) => r.completion === 0).length;
console.log('ZERO_COMPLETION_TEAMS:', zero, '/', all.length);

console.log('\n=== COMMAND 3 ===');
const db = new Database(DB, { readonly: true });
const rows = db
  .prepare(
    `SELECT k.id, k.status, k.assigned_to, datetime(k.created_at) as created
     FROM tasks k
     WHERE json_extract(k.metadata_json,'$.teamId')='team_gov-engineering-reliability'
       AND k.created_at >= datetime('now','-48 hours')
     ORDER BY k.created_at`,
  )
  .all();
for (const row of rows) {
  console.log(Object.values(row as Record<string, unknown>).join('|'));
}
if (rows.length === 0) {
  console.log('(no rows)');
}

console.log('\n=== COMMAND 4 ===');
const approved = db
  .prepare(
    `SELECT COUNT(*) as approved FROM tasks WHERE json_extract(metadata_json,'$.verificationStatus')='approved'`,
  )
  .get() as { approved: number };
console.log(approved.approved);

db.close();

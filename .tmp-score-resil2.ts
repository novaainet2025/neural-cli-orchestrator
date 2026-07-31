import { getDb } from './src/storage/database.js';
import { buildFalseCompletionExclusion } from './src/core/false-completion.js';
const db = getDb();
const excl = buildFalseCompletionExclusion();
const rows = db.prepare(`
  SELECT k.id, k.status, k.assigned_to, LENGTH(COALESCE(k.response,'')) AS b
  FROM tasks k
  WHERE k.team_id='team_gov-assurance-resilience'
    AND k.created_at >= datetime('now','-48 hours')
    AND NOT (1=0 ${excl.replace(/^AND NOT/, 'AND NOT')})
  ORDER BY k.created_at`).all();
console.log('rows surviving false-completion filter:', rows.length);
console.log(JSON.stringify(rows, null, 1));

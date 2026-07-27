import Database from 'better-sqlite3';
import fs from 'fs';

const db = new Database('db/nco.db', { readonly: true });
const rows = db.prepare(`
  SELECT id, status, assigned_to, substr(error, 1, 120) AS err
  FROM tasks
  WHERE team_id = 'team_hr-incubator-2026-w30'
    AND julianday(created_at) >= julianday('now', '-48 hours')
  ORDER BY created_at
`).all();

const out = rows.map((r) => `${r.id}|${r.status}|${r.assigned_to ?? ''}|${r.err ?? ''}`).join('\n');
const path = 'data/error-prevention/hr-incubator-2026-w30-tasks-48h.txt';
fs.writeFileSync(path, out ? `${out}\n` : '');
console.log(`wrote ${rows.length} rows to ${path}`);
db.close();

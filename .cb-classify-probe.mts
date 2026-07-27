import Database from 'better-sqlite3';
import { classifyCircuitError } from './src/security/circuit-breaker-registry.js';

const db = new Database('/tmp/nco-dupaudit-c2.db', { readonly: true });
const rows = db.prepare(`
  SELECT id, team_id, assigned_to, completed_at, error, response
  FROM tasks
  WHERE status <> 'completed'
    AND COALESCE(error,'') LIKE '%CLI failed exit=%'
    AND COALESCE(response,'') LIKE '{"type":"error"%'
  ORDER BY completed_at
`).all() as any[];

console.log(`rows matching PROVIDER_AUTH_EXCLUSION guard: ${rows.length}`);
for (const r of rows) {
  const fromError = classifyCircuitError(r.error);
  const fromResponse = classifyCircuitError(r.response);
  let parsed = 'no';
  try { const o = JSON.parse(String(r.response).trim()); parsed = o?.type === 'error' ? 'yes(type=error)' : `yes(type=${o?.type})`; } catch { parsed = 'PARSE-FAIL'; }
  console.log([
    r.id.padEnd(24),
    (r.team_id ?? '-').padEnd(30),
    r.assigned_to.padEnd(12),
    r.completed_at,
    'error→' + (fromError ? `${fromError.reason}/${fromError.immediateOpen}` : 'null(generic-threshold)'),
    'response→' + (fromResponse ? `${fromResponse.reason}/${fromResponse.immediateOpen}` : 'null'),
    'jsonParse=' + parsed,
  ].join(' | '));
}

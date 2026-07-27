import Database from 'better-sqlite3';
import { classifyCircuitError } from './src/security/circuit-breaker-registry.js';

const db = new Database('/tmp/nco-dupaudit-c2.db', { readonly: true });
const rows = db.prepare(`
  SELECT id, team_id, assigned_to, completed_at, error, response
  FROM tasks
  WHERE status IN ('failed','timed_out','lease_expired')
    AND completed_at >= datetime('now','-48 hours')
    AND COALESCE(error,'') <> ''
`).all() as any[];

// echo 경계: "Command failed with exit code N: <cmd …prompt…>" 뒤쪽 전체가 명령 에코다.
const ECHO_BOUNDARY = /Command failed with exit code [^:]*:\s/;
let total = 0, classified = 0, echoOnly = 0, headOnly = 0;
const echoRows: any[] = [];
for (const r of rows) {
  total++;
  const c = classifyCircuitError(r.error);
  if (!c) continue;
  classified++;
  const m = ECHO_BOUNDARY.exec(r.error);
  if (!m) { headOnly++; continue; }
  const head = r.error.slice(0, m.index + m[0].length);
  const cHead = classifyCircuitError(head);
  if (!cHead) { echoOnly++; echoRows.push({ id: r.id, team: r.team_id, agent: r.assigned_to, at: r.completed_at, reason: c.reason, matched: c.matchedText }); }
  else headOnly++;
}
console.log(JSON.stringify({ total_48h_failures: total, classified_nonnull: classified, classified_from_echo_only: echoOnly, classified_from_head: headOnly }, null, 2));
console.log('--- echo-only (프롬프트 에코가 분류를 유발한 행) ---');
for (const e of echoRows) console.log(JSON.stringify(e));

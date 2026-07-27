/**
 * Read-only blast-radius probe for cycle3 중복에러방지 (team_gov-evolution-learning).
 * Replays the LANDED envelope gate (a8c285a, src/security/circuit-breaker-registry.ts)
 * over real tasks rows to measure:
 *   (a) true positives  — failed rows whose `error` is unclassified but whose `response`
 *                         is a hard-401 provider envelope (= duplicate probe consumption stopped)
 *   (b) false positives — completed rows (real team deliverables) that would be classified
 * Read-only: opens a copy of db/nco.db, never writes.
 */
import Database from 'better-sqlite3';
import {
  classifyProviderErrorEnvelope,
  classifyCircuitError,
} from './src/security/circuit-breaker-registry.js';

const db = new Database('/tmp/nco-c3-dup.db', { readonly: true });
const cutoff = (db.prepare("SELECT datetime('now','-48 hours') AS c").get() as { c: string }).c;

type Row = {
  id: string;
  status: string;
  assigned_to: string | null;
  team_id: string | null;
  error: string | null;
  response: string | null;
  created_at: string;
};

const rows = db
  .prepare(
    `SELECT id, status, assigned_to, team_id, error, response, created_at
       FROM tasks WHERE response IS NOT NULL AND response != '' ORDER BY created_at ASC`,
  )
  .all() as Row[];

const rows48 = rows.filter((r) => r.created_at >= cutoff);

function report(label: string, set: Row[]) {
  const hits = set.filter((r) => classifyProviderErrorEnvelope(r.response, 'on') !== null);
  const failedHits = hits.filter((r) => ['failed', 'error', 'timeout'].includes(r.status));
  const completedHits = hits.filter((r) => r.status === 'completed');
  const alreadyClassified = failedHits.filter((r) => classifyCircuitError(r.error ?? '') !== null);
  console.log(`\n=== ${label} ===`);
  console.log(`rows with response      : ${set.length}`);
  console.log(`envelope-classified     : ${hits.length}`);
  console.log(`  on failed/error rows  : ${failedHits.length}  (true positive candidates)`);
  console.log(`    already CB-classified via error col : ${alreadyClassified.length} (gate adds nothing)`);
  console.log(`    NEW immediate-open   : ${failedHits.length - alreadyClassified.length}`);
  console.log(`  on completed rows     : ${completedHits.length}  (FALSE POSITIVES)`);
  for (const r of hits.slice(0, 10)) {
    console.log(
      `   ${r.id} [${r.created_at}] status=${r.status} agent=${r.assigned_to} team=${r.team_id ?? '-'}`,
    );
  }
  return { hits, failedHits, completedHits, alreadyClassified };
}

report('ALL-TIME', rows);
report('48h', rows48);

// off-toggle regression: gate must be a strict no-op when disabled
const offHits = rows.filter((r) => classifyProviderErrorEnvelope(r.response, 'off') !== null);
console.log(`\nNCO_CB_ERROR_ENVELOPE=off  -> classified: ${offHits.length} (expected 0)`);

// completed rows whose body *quotes* 401/invalid api key — the documented false-positive risk
const quoting = rows.filter(
  (r) => r.status === 'completed' && /401|invalid x-api-key|invalid api key/i.test(r.response ?? ''),
);
const quotingMisfire = quoting.filter((r) => classifyProviderErrorEnvelope(r.response, 'on') !== null);
console.log(
  `completed rows QUOTING auth strings: ${quoting.length}  -> misclassified by gate: ${quotingMisfire.length} (expected 0)`,
);

// team-local view
const teamRows = rows48.filter((r) => r.team_id === 'team_gov-evolution-learning');
console.log(`\nteam_gov-evolution-learning 48h rows with response: ${teamRows.length}`);
for (const r of teamRows) {
  console.log(
    `  ${r.id} status=${r.status} envelope=${classifyProviderErrorEnvelope(r.response, 'on') ? 'AUTH' : '-'} errClass=${classifyCircuitError(r.error ?? '')?.reason ?? '-'}`,
  );
}
db.close();

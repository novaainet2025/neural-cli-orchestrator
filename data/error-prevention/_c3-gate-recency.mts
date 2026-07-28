/** GATE-COLLAB-C3-R1 hit recency + mode distribution (읽기 전용). */
import Database from 'better-sqlite3';
import { isProtocolReconversionPrompt } from '../../src/core/collaboration.js';

const db = new Database('db/nco.db', { readonly: true });
const rows = db.prepare(
  `SELECT id, prompt, status, mode, assigned_to, delegated_from, team_id, created_at FROM tasks`,
).all() as Array<Record<string, string | null>>;

const hits = rows.filter((r) => isProtocolReconversionPrompt(r.prompt));
const byDay: Record<string, number> = {};
const byMode: Record<string, number> = {};
const byDelegated: Record<string, number> = {};
for (const h of hits) {
  const day = (h.created_at ?? '').slice(0, 10);
  byDay[day] = (byDay[day] ?? 0) + 1;
  byMode[h.mode ?? 'null'] = (byMode[h.mode ?? 'null'] ?? 0) + 1;
  byDelegated[h.delegated_from ?? 'null'] = (byDelegated[h.delegated_from ?? 'null'] ?? 0) + 1;
}
console.log('total_hits=', hits.length);
console.log('\nby_day=');
for (const d of Object.keys(byDay).sort()) console.log(`  ${d}  ${byDay[d]}`);
console.log('\nby_mode=', JSON.stringify(byMode));
console.log('\nby_delegated_from=', JSON.stringify(byDelegated));

const days = Object.keys(byDay).sort();
console.log('\nfirst_hit_day=', days[0], ' last_hit_day=', days[days.length - 1]);

// 최근 30일 구간 히트
const recent = hits.filter((h) => (h.created_at ?? '') >= '2026-06-28');
console.log('hits_since_2026-06-28=', recent.length);
db.close();

/**
 * Read-only probe: exact 60s SLIDING-window maxima over the full mesh_messages
 * history, to test the numbers cited in collaboration-loop-guard.ts's header
 * ("identical body up to 72x in 60s", "channel up to 41 msgs/min").
 * Minute-bucket GROUP BY under-counts sliding windows, so this recomputes properly.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

const WINDOW_MS = 60_000;
const db = new Database('db/nco.db', { readonly: true });

const rows = db
  .prepare(
    `SELECT from_session, to_session, content, created_at
       FROM mesh_messages ORDER BY created_at ASC`,
  )
  .all() as Array<{ from_session: string; to_session: string; content: string; created_at: string }>;

const sig = (c: string) => createHash('sha1').update(c.replace(/\s+/g, ' ').trim()).digest('hex');

const perChannel = new Map<string, Array<{ at: number; s: string }>>();
let maxRepeat = { n: 0, ch: '', at: '' };
let maxVolume = { n: 0, distinct: 0, ch: '', at: '' };

for (const r of rows) {
  const at = Date.parse(r.created_at);
  const ch = `${r.from_session}->${r.to_session}`;
  const s = sig(r.content);
  const hist = (perChannel.get(ch) ?? []).filter(e => e.at > at - WINDOW_MS);
  hist.push({ at, s });
  perChannel.set(ch, hist);

  const repeats = hist.filter(e => e.s === s).length;
  if (repeats > maxRepeat.n) maxRepeat = { n: repeats, ch, at: r.created_at };
  if (hist.length > maxVolume.n) {
    maxVolume = { n: hist.length, distinct: new Set(hist.map(e => e.s)).size, ch, at: r.created_at };
  }
}

console.log(`rows analysed            : ${rows.length}`);
console.log(`max identical-body / 60s : ${maxRepeat.n}  @ ${maxRepeat.ch} ${maxRepeat.at}`);
console.log(`max channel msgs / 60s   : ${maxVolume.n} (distinct bodies ${maxVolume.distinct}) @ ${maxVolume.ch} ${maxVolume.at}`);

// Distribution of channel-window volumes, to size the burst threshold.
const volumes: number[] = [];
const per2 = new Map<string, Array<number>>();
for (const r of rows) {
  const at = Date.parse(r.created_at);
  const ch = `${r.from_session}->${r.to_session}`;
  const hist = (per2.get(ch) ?? []).filter(e => e > at - WINDOW_MS);
  hist.push(at);
  per2.set(ch, hist);
  volumes.push(hist.length);
}
volumes.sort((a, b) => a - b);
const pct = (p: number) => volumes[Math.min(volumes.length - 1, Math.floor((p / 100) * volumes.length))];
console.log(`window-volume p50/p95/p99/p99.9/max : ${pct(50)}/${pct(95)}/${pct(99)}/${pct(99.9)}/${volumes[volumes.length - 1]}`);
db.close();

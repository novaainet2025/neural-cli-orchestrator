/**
 * Read-only blast-radius probe for cycle3 중복에러방지 deliverables.
 * (1) GATE-COLLAB-C3-R1: replay every real tasks.prompt through the LIVE
 *     isProtocolReconversionPrompt() to count would-be 409s (48h + all-time),
 *     and split them into true re-conversions vs legitimate blocked prompts.
 * (2) CB-COLLAB-C3-R2: replay 48h mesh_messages through the LIVE guard with
 *     protocol-echo ON vs OFF to measure the added block count and whether any
 *     added block hit a DISTINCT body (= false positive).
 * Not part of the build. Read-only: no writes to db/nco.db.
 */
import Database from 'better-sqlite3';
import { isProtocolReconversionPrompt } from './src/core/collaboration.js';
import {
  CollaborationLoopGuard,
  collaborationChannelKey,
  isProtocolPrefixedContent,
  DEFAULT_COLLABORATION_LOOP_CONFIG,
} from './src/security/collaboration-loop-guard.js';

const db = new Database('db/nco.db', { readonly: true });
const cutoff = (db
  .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now','-48 hours') AS c")
  .get() as { c: string }).c;

// ---------- (1) intake gate ----------
const tasks = db
  .prepare(`SELECT id, prompt, created_at, team_id, status FROM tasks ORDER BY created_at ASC`)
  .all() as Array<{ id: string; prompt: string; created_at: string; team_id: string | null; status: string }>;

const blocked = tasks.filter(t => isProtocolReconversionPrompt(t.prompt));
const blocked48 = blocked.filter(t => t.created_at >= cutoff);
const tasks48 = tasks.filter(t => t.created_at >= cutoff);

console.log('=== (1) GATE-COLLAB-C3-R1 intake replay ===');
console.log(`cutoff(48h UTC)   : ${cutoff}`);
console.log(`tasks all-time    : ${tasks.length}  -> would 409: ${blocked.length} (${(blocked.length / tasks.length * 100).toFixed(2)}%)`);
console.log(`tasks last 48h    : ${tasks48.length}  -> would 409: ${blocked48.length}`);
const byTeam = new Map<string, number>();
for (const t of blocked) byTeam.set(t.team_id ?? '(null)', (byTeam.get(t.team_id ?? '(null)') ?? 0) + 1);
console.log('blocked by team_id:', JSON.stringify(Object.fromEntries([...byTeam].sort((a, b) => b[1] - a[1]).slice(0, 10))));
const byStatus = new Map<string, number>();
for (const t of blocked) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
console.log('blocked by status :', JSON.stringify(Object.fromEntries(byStatus)));
console.log('date range        :', blocked.length ? `${blocked[0].created_at} .. ${blocked[blocked.length - 1].created_at}` : 'n/a');
console.log('--- sample (first 120 chars of up to 8) ---');
for (const t of blocked.slice(0, 8)) {
  console.log(`  ${t.id} [${t.created_at}] ${JSON.stringify(t.prompt.slice(0, 120))}`);
}

// ---------- (2) mesh guard ----------
const msgs = db
  .prepare(`SELECT id, from_session, to_session, content, created_at FROM mesh_messages
             WHERE created_at >= ? ORDER BY created_at ASC`)
  .all(cutoff) as Array<{ id: string; from_session: string; to_session: string; content: string; created_at: string }>;

function replay(maxProtocolRepeatsPerWindow: number) {
  const guard = new CollaborationLoopGuard({ ...DEFAULT_COLLABORATION_LOOP_CONFIG, maxProtocolRepeatsPerWindow });
  const byRule = new Map<string, number>();
  const blockedIds = new Set<string>();
  for (const m of msgs) {
    const at = Date.parse(m.created_at);
    const d = guard.check(collaborationChannelKey(m.from_session, m.to_session), m.content, at);
    if (!d.allowed) {
      byRule.set(d.rule ?? '?', (byRule.get(d.rule ?? '?') ?? 0) + 1);
      blockedIds.add(m.id);
    }
  }
  return { byRule, blockedIds };
}

const off = replay(DEFAULT_COLLABORATION_LOOP_CONFIG.maxRepeatsPerWindow); // protocol cap == generic cap => rule effectively neutral
const on = replay(DEFAULT_COLLABORATION_LOOP_CONFIG.maxProtocolRepeatsPerWindow);

console.log('\n=== (2) CB-COLLAB-C3-R2 mesh replay (48h) ===');
console.log(`mesh_messages 48h : ${msgs.length}`);
console.log(`protocol-prefixed : ${msgs.filter(m => isProtocolPrefixedContent(m.content)).length}`);
console.log(`baseline (cap=3)  : blocked ${off.blockedIds.size} ${JSON.stringify(Object.fromEntries(off.byRule))}`);
console.log(`new      (cap=1)  : blocked ${on.blockedIds.size} ${JSON.stringify(Object.fromEntries(on.byRule))}`);

const added = msgs.filter(m => on.blockedIds.has(m.id) && !off.blockedIds.has(m.id));
console.log(`added blocks      : ${added.length}`);
// false positive = an added block whose body is NOT identical to an earlier body in the same channel/window
const seen = new Map<string, Array<{ at: number; body: string }>>();
let fp = 0;
for (const m of msgs) {
  const at = Date.parse(m.created_at);
  const ch = collaborationChannelKey(m.from_session, m.to_session);
  const norm = m.content.replace(/\s+/g, ' ').trim();
  const hist = (seen.get(ch) ?? []).filter(e => e.at > at - DEFAULT_COLLABORATION_LOOP_CONFIG.windowMs);
  if (added.some(a => a.id === m.id) && !hist.some(e => e.body === norm)) fp++;
  hist.push({ at, body: norm });
  seen.set(ch, hist);
}
console.log(`added blocks on DISTINCT bodies (false positives): ${fp}`);
db.close();

/**
 * Read-only forward-estimate probe for CB-COLLAB-C3-R2 / channel-burst.
 *
 * CAUTION (learned the hard way): CollaborationLoopGuard.check(channel, content, config)
 * takes a CONFIG as 3rd arg and reads Date.now() internally — it has no injectable clock.
 * Passing a timestamp there silently degrades to "all messages arrive at the same instant"
 * and yields a bogus ~92% block rate. This probe stubs Date.now instead.
 *
 * The 48h mesh_messages were all written by a pre-guard runtime (guard wired
 * 2026-07-28 04:39 in a8c285a; live backend pid 10569 started 02:46), so this is a
 * FORWARD estimate of what the guard will block once actually deployed.
 */
import Database from 'better-sqlite3';
import {
  CollaborationLoopGuard,
  collaborationChannelKey,
  isProtocolPrefixedContent,
  DEFAULT_COLLABORATION_LOOP_CONFIG,
  type CollaborationLoopRuleConfig,
} from './src/security/collaboration-loop-guard.js';

const db = new Database('db/nco.db', { readonly: true });
const cutoff = (db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now','-48 hours') AS c").get() as { c: string }).c;
const msgs = db
  .prepare(`SELECT id, from_session, to_session, content, created_at FROM mesh_messages
             WHERE created_at >= ? ORDER BY created_at ASC`)
  .all(cutoff) as Array<{ id: string; from_session: string; to_session: string; content: string; created_at: string }>;

const realNow = Date.now;
function replay(cfg: Partial<CollaborationLoopRuleConfig>) {
  const guard = new CollaborationLoopGuard();
  const hist = new Map<string, Array<{ at: number; body: string }>>();
  const byRule = new Map<string, number>();
  let blocked = 0, dup = 0, fp = 0;
  const blockedIds = new Set<string>();
  for (const m of msgs) {
    const at = Date.parse(m.created_at);
    const ch = collaborationChannelKey(m.from_session, m.to_session);
    const norm = m.content.replace(/\s+/g, ' ').trim();
    const h = (hist.get(ch) ?? []).filter(e => e.at > at - (cfg.windowMs ?? DEFAULT_COLLABORATION_LOOP_CONFIG.windowMs));
    const isDup = h.some(e => e.body === norm);
    Date.now = () => at;                       // faithful clock injection
    const d = guard.check(ch, m.content, cfg);
    Date.now = realNow;
    if (!d.allowed) {
      blocked++; blockedIds.add(m.id);
      byRule.set(d.rule ?? 'cooldown', (byRule.get(d.rule ?? 'cooldown') ?? 0) + 1);
      if (isDup) dup++; else fp++;
    }
    h.push({ at, body: norm }); hist.set(ch, h);
  }
  return { blocked, dup, fp, byRule, blockedIds };
}

console.log(`48h mesh_messages : ${msgs.length}`);
console.log(`protocol-prefixed : ${msgs.filter(m => isProtocolPrefixedContent(m.content)).length}`);

// protocol-echo OFF-equivalent (protocol cap == generic cap) vs shipped default (cap=1)
const off = replay({ maxProtocolRepeatsPerWindow: DEFAULT_COLLABORATION_LOOP_CONFIG.maxRepeatsPerWindow });
const on = replay({});
for (const [label, r] of [['baseline protocol-cap=3', off], ['shipped  protocol-cap=1', on]] as const) {
  console.log(`\n${label}`);
  console.log(`  blocked ${r.blocked} (${(r.blocked / msgs.length * 100).toFixed(2)}%)  rules=${JSON.stringify(Object.fromEntries(r.byRule))}`);
  console.log(`  on duplicate body (true positive) : ${r.dup}`);
  console.log(`  on distinct  body (false positive): ${r.fp}`);
}
const added = [...on.blockedIds].filter(id => !off.blockedIds.has(id));
console.log(`\nprotocol-echo added blocks vs baseline: ${added.length} ${JSON.stringify(added.slice(0, 5))}`);
db.close();

// detail of the 7 shipped-config blocks
{
  const guard = new CollaborationLoopGuard();
  const rn = Date.now;
  for (const m of msgs) {
    const at = Date.parse(m.created_at);
    const ch = collaborationChannelKey(m.from_session, m.to_session);
    Date.now = () => at;
    const d = guard.check(ch, m.content);
    Date.now = rn;
    if (!d.allowed) console.log(`BLOCK ${m.created_at} rule=${d.rule} ch=${ch} repeats=${d.repeats} window=${d.windowCount} body=${JSON.stringify(m.content.replace(/\s+/g,' ').slice(0,70))}`);
  }
}

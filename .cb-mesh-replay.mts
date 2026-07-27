/**
 * Replay probe (read-only): feed real 48h mesh_messages through the live
 * CollaborationLoopGuard to measure block rate and classify each block as
 * echo-loop (true dup) vs channel-burst on distinct bodies (false positive).
 * Not part of the build; deleted or kept only as evidence.
 */
import Database from 'better-sqlite3';
import {
  CollaborationLoopGuard,
  collaborationChannelKey,
  DEFAULT_COLLABORATION_LOOP_CONFIG,
  type CollaborationLoopRuleConfig,
} from './src/security/collaboration-loop-guard.js';

const db = new Database('db/nco.db', { readonly: true });
const cutoff = db
  .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now','-48 hours') AS c")
  .get() as { c: string };

const rows = db
  .prepare(
    `SELECT id, from_session, to_session, content, created_at
       FROM mesh_messages
      WHERE created_at >= ?
      ORDER BY created_at ASC`,
  )
  .all(cutoff.c) as Array<{
  id: string;
  from_session: string;
  to_session: string;
  content: string;
  created_at: string;
}>;

const overrides: Array<{ label: string; config?: Partial<CollaborationLoopRuleConfig> }> = [
  { label: 'current (burst=20/60s)' },
  { label: 'proposed (burst=60/60s)', config: { maxMessagesPerWindow: 60 } },
];

const realNow = Date.now;

for (const variant of overrides) {
  const guard = new CollaborationLoopGuard();
  const cfg = { ...DEFAULT_COLLABORATION_LOOP_CONFIG, ...variant.config };
  // Per-channel recent identical-body log, used ONLY to classify a block as a
  // genuine duplicate or a distinct-body false positive.
  const recent = new Map<string, Array<{ at: number; body: string }>>();

  let allowed = 0;
  const blocked = { 'echo-loop': 0, 'channel-burst': 0 } as Record<string, number>;
  let burstOnDistinct = 0;
  const affectedChannels = new Set<string>();

  for (const row of rows) {
    const at = Date.parse(row.created_at);
    Date.now = () => at;
    const channel = collaborationChannelKey(row.from_session, row.to_session);
    const decision = guard.check(channel, row.content, variant.config);

    const norm = row.content.replace(/\s+/g, ' ').trim();
    const hist = (recent.get(channel) ?? []).filter(e => e.at > at - cfg.windowMs);
    const dupInWindow = hist.some(e => e.body === norm);
    hist.push({ at, body: norm });
    recent.set(channel, hist);

    if (decision.allowed) {
      allowed++;
    } else {
      blocked[decision.rule ?? 'cooldown'] = (blocked[decision.rule ?? 'cooldown'] ?? 0) + 1;
      affectedChannels.add(channel);
      if (!dupInWindow) burstOnDistinct++;
    }
  }

  Date.now = realNow;
  const total = rows.length;
  const blockedTotal = total - allowed;
  console.log(`--- ${variant.label} ---`);
  console.log(`  messages replayed : ${total}`);
  console.log(`  allowed           : ${allowed}`);
  console.log(`  blocked           : ${blockedTotal} (${((blockedTotal / total) * 100).toFixed(1)}%)`);
  console.log(`  by rule           : ${JSON.stringify(blocked)}`);
  console.log(`  blocked w/ UNIQUE body in window (false positive): ${burstOnDistinct}`);
  console.log(`  channels affected : ${affectedChannels.size} ${JSON.stringify([...affectedChannels])}`);
}

db.close();

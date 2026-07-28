/**
 * CB-COLLAB-C3-R2 (protocol-echo / echo-loop / channel-burst) 실데이터 리플레이.
 * 실제 CollaborationLoopGuard를 mesh_messages 시간순으로 먹여 차단률을 측정한다.
 * 읽기 전용. 벽시계 대신 각 메시지의 created_at을 쓰기 위해 Date.now를 스텁한다.
 */
import Database from 'better-sqlite3';
import {
  CollaborationLoopGuard,
  collaborationChannelKey,
  isProtocolPrefixedContent,
} from '../../src/security/collaboration-loop-guard.js';

const db = new Database('db/nco.db', { readonly: true });
const rows = db.prepare(
  `SELECT id, from_session, to_session, content, created_at FROM mesh_messages
   WHERE created_at >= datetime('now','-48 hours') ORDER BY created_at ASC`,
).all() as Array<{ id: string; from_session: string; to_session: string; content: string; created_at: string }>;

const realNow = Date.now;
function replay(label: string, cfg: Record<string, number> | undefined) {
  const guard = new CollaborationLoopGuard();
  const blocked: Record<string, number> = {};
  let protocolMsgs = 0;
  let allowed = 0;
  let unparsed = 0;
  const samples: string[] = [];
  for (const r of rows) {
    // created_at은 ISO8601(...Z)과 'YYYY-MM-DD HH:MM:SS' 두 형식이 섞여 있다.
    // 무조건 'Z'를 덧붙이면 '...ZZ' → NaN이 되어 윈도가 통째로 무력화된다.
    const raw = r.created_at.trim();
    const iso = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)
      ? raw.replace(' ', 'T')
      : raw.replace(' ', 'T') + 'Z';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) { unparsed++; continue; }
    // guard 내부 Date.now()를 메시지 시각으로 고정 → 실제 시간축 재현
    (Date as unknown as { now: () => number }).now = () => t;
    if (isProtocolPrefixedContent(r.content)) protocolMsgs++;
    const d = guard.check(collaborationChannelKey(r.from_session, r.to_session), r.content, cfg);
    if (d.allowed) allowed++;
    else {
      blocked[d.rule ?? 'null'] = (blocked[d.rule ?? 'null'] ?? 0) + 1;
      if (samples.length < 8) {
        samples.push(`    ${r.created_at} ${d.rule} ${r.from_session}->${r.to_session} :: ${r.content.replace(/\s+/g, ' ').slice(0, 60)}`);
      }
    }
  }
  (Date as unknown as { now: () => number }).now = realNow;
  const totalBlocked = Object.values(blocked).reduce((a, b) => a + b, 0);
  console.log(`\n=== ${label} ===`);
  console.log(`msgs=${rows.length} unparsed_ts=${unparsed} protocol_prefixed=${protocolMsgs} allowed=${allowed} blocked=${totalBlocked} (${((totalBlocked / rows.length) * 100).toFixed(2)}%)`);
  console.log('  by_rule=', JSON.stringify(blocked));
  for (const s of samples) console.log(s);
}

replay('SHIPPED defaults (protocol=1, echo=3, burst=20/60s)', undefined);
replay('COUNTERFACTUAL: protocol-echo disabled (protocol=3 = echo-loop)', { maxProtocolRepeatsPerWindow: 3 });
replay('COUNTERFACTUAL: burst 60/60s (제안값, 미채택)', { maxMessagesPerWindow: 60 });

db.close();

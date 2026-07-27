/**
 * CB-COLLAB-C4-AB — 통지원 볼륨-룰 면제의 반사실 A/B 리플레이 (읽기 전용).
 *
 * 같은 실데이터(고정 48h 창)를 세 가지 가드에 먹이고 동일 포맷으로 출력한다.
 *   GUARD_MODULE=<절대경로>  — 리플레이할 가드 모듈
 *   NCO_MESH_LOOP_GUARD_NOTIFIERS=off — 면제 해제(패치본에서만 의미 있음)
 * 출력은 바이트 비교용이므로 시각·난수·경로를 일절 찍지 않는다.
 *
 * 시간창: 상한을 벽시계가 아닌 고정 timestamp로 잡아 재실행 시 동일 결과를 낸다.
 * created_at은 ISO(...Z)와 'YYYY-MM-DD HH:MM:SS'가 섞여 있어 문자열 비교가 아니라
 * julianday()로 자른다(cycle3의 3018/844 수치는 문자열 비교 오류의 산물).
 */
import Database from 'better-sqlite3';

const UPPER = '2026-07-27T20:50:00Z';
const modulePath = process.env.GUARD_MODULE;
if (!modulePath) throw new Error('GUARD_MODULE required');

const mod = (await import(modulePath)) as {
  CollaborationLoopGuard: new () => {
    check(channel: string, content: string, cfg?: unknown): { allowed: boolean; rule?: string };
  };
  collaborationChannelKey(from: string, to: string): string;
};

const db = new Database('db/nco.db', { readonly: true });
const rows = db.prepare(
  `SELECT id, from_session, to_session, content, created_at FROM mesh_messages
    WHERE julianday(replace(replace(created_at,'T',' '),'Z','')) >= julianday(?) - 2.0
      AND julianday(replace(replace(created_at,'T',' '),'Z','')) <= julianday(?)
    ORDER BY created_at ASC, id ASC`,
).all(UPPER, UPPER) as Array<{
  id: string; from_session: string; to_session: string; content: string; created_at: string;
}>;

const realNow = Date.now;
const guard = new mod.CollaborationLoopGuard();
const byRule: Record<string, number> = {};
const blockedRows: string[] = [];
let allowed = 0;
let unparsed = 0;

for (const r of rows) {
  const raw = r.created_at.trim();
  const iso = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)
    ? raw.replace(' ', 'T')
    : raw.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) { unparsed++; continue; }
  (Date as unknown as { now: () => number }).now = () => t;
  const d = guard.check(mod.collaborationChannelKey(r.from_session, r.to_session), r.content);
  if (d.allowed) allowed++;
  else {
    byRule[d.rule ?? 'null'] = (byRule[d.rule ?? 'null'] ?? 0) + 1;
    // 차단된 행은 전부 찍는다 — 표본이 아니라 전수여야 A/B 바이트 비교가 의미를 가진다.
    blockedRows.push(
      `BLOCKED ${r.id} ${r.created_at} rule=${d.rule} ${r.from_session}->${r.to_session} :: ` +
      r.content.replace(/\s+/g, ' ').slice(0, 80),
    );
  }
}
(Date as unknown as { now: () => number }).now = realNow;

const totalBlocked = Object.values(byRule).reduce((a, b) => a + b, 0);
console.log(`window_upper=${UPPER} span=48h`);
console.log(`msgs=${rows.length} unparsed_ts=${unparsed} allowed=${allowed} blocked=${totalBlocked}`);
console.log(`by_rule=${JSON.stringify(byRule, Object.keys(byRule).sort())}`);
for (const line of blockedRows) console.log(line);

db.close();

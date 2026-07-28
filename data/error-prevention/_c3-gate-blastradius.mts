/**
 * GATE-COLLAB-C3-R1 blast-radius probe (중복에러방지팀 cycle3).
 * 실제 gateway가 쓰는 판정 함수를 그대로 import 해 재구현 드리프트를 제거한다.
 * 읽기 전용: DB에 쓰지 않는다.
 */
import Database from 'better-sqlite3';
import { isProtocolReconversionPrompt } from '../../src/core/collaboration.js';

const db = new Database('db/nco.db', { readonly: true });

function scan(label: string, sql: string) {
  const rows = db.prepare(sql).all() as Array<{
    id: string;
    prompt: string | null;
    status: string | null;
    team_id: string | null;
    created_at: string | null;
  }>;
  const hits = rows.filter((r) => isProtocolReconversionPrompt(r.prompt));
  console.log(`\n=== ${label} ===`);
  console.log(`total=${rows.length} blocked=${hits.length}`);
  const byStatus: Record<string, number> = {};
  for (const h of hits) byStatus[h.status ?? 'null'] = (byStatus[h.status ?? 'null'] ?? 0) + 1;
  console.log('blocked_by_status=', JSON.stringify(byStatus));
  for (const h of hits.slice(0, 15)) {
    const first = (h.prompt ?? '').split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 80);
    console.log(`  ${h.id} | ${h.status} | ${h.team_id ?? '-'} | ${h.created_at} | ${first}`);
  }
  return hits.length;
}

scan(
  '48h ALL tasks',
  `SELECT id, prompt, status, team_id, created_at FROM tasks
   WHERE created_at >= datetime('now','-48 hours')`,
);
scan(
  '48h team_gov-command-collaboration',
  `SELECT id, prompt, status, team_id, created_at FROM tasks
   WHERE created_at >= datetime('now','-48 hours')
     AND team_id='team_gov-command-collaboration'`,
);
scan(
  'ALL TIME tasks',
  `SELECT id, prompt, status, team_id, created_at FROM tasks`,
);
scan(
  'ALL TIME completed only (over-block check)',
  `SELECT id, prompt, status, team_id, created_at FROM tasks WHERE status='completed'`,
);

db.close();

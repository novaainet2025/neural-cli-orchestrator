/**
 * team_cli-experience-2026 (CLI 경험 설계팀) 48h 표본 분해 진단.
 *
 * 실제 team-scorer의 computeTeamScores()를 그대로 사용해, DB 복사본에서 태스크를
 * 하나씩 팀에서 분리(team_id=NULL)했을 때 n/completed가 어떻게 변하는지로
 * "이 태스크가 분모에 들어가는가 / 분자에 들어가는가"를 역산한다.
 * 스코어러 로직을 재구현하지 않으므로 판정이 라이브와 어긋날 수 없다(read-only 진단).
 *
 * 사용: npx tsx scripts/diagnose-cli-experience.ts [teamId]
 */
import Database from 'better-sqlite3';
import { copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeTeamScores } from '../src/core/team-scorer.js';

const TEAM_ID = process.argv[2] ?? 'team_cli-experience-2026';
const SRC = 'db/nco.db';
const COPY = join(tmpdir(), `nco-diagnose-${process.pid}.db`);

copyFileSync(SRC, COPY);
const db = new Database(COPY);

function scoreOf(): { n: number; completed: number; completion: number; score: number } | null {
  const row = computeTeamScores(db).find((t) => t.teamId === TEAM_ID);
  if (!row) return null;
  return {
    n: row.n,
    completed: Math.round((row.completion / 100) * row.n),
    completion: row.completion,
    score: row.score,
  };
}

const base = scoreOf();
if (!base) {
  console.error(`team ${TEAM_ID} not found / inactive`);
  process.exit(1);
}
console.log(`baseline: n=${base.n} completed≈${base.completed} completion=${base.completion}% score=${base.score}`);

const tasks = db.prepare(`
  SELECT id, status, assigned_to, spawned_by_cli, error, created_at,
         LENGTH(COALESCE(response,'')) AS resp_len,
         json_extract(metadata_json,'$.workReportId') AS wr
  FROM tasks
  WHERE team_id = ?
    AND status IN ('completed','failed','timed_out','lease_expired')
    AND julianday(created_at) >= julianday('now','-48 hours')
  ORDER BY created_at
`).all(TEAM_ID) as Array<Record<string, unknown>>;

console.log(`\n48h terminal-status rows (raw): ${tasks.length}\n`);

const detach = db.prepare('UPDATE tasks SET team_id = NULL WHERE id = ?');
const attach = db.prepare('UPDATE tasks SET team_id = ? WHERE id = ?');

for (const t of tasks) {
  const id = t.id as string;
  detach.run(id);
  const without = scoreOf();
  attach.run(TEAM_ID, id);

  const inDenominator = (without?.n ?? 0) < base.n;
  const inNumerator = (without?.completed ?? 0) < base.completed;
  const verdict = !inDenominator
    ? 'EXCLUDED (분모 밖)'
    : inNumerator
      ? 'counted: SUCCESS'
      : 'counted: FAILURE ← 감점';

  console.log(
    [
      id,
      t.status,
      t.assigned_to,
      t.spawned_by_cli ?? '-',
      `resp=${t.resp_len}B`,
      t.wr ? `wr=${t.wr}` : '-',
      verdict,
      t.error ? `err=${String(t.error).replace(/\s+/g, ' ').slice(0, 80)}` : '',
    ].join(' | '),
  );
}

db.close();

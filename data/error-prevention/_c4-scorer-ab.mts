/**
 * CB-COLLAB-C4-SCORER-AB — 스코어러 제외 룰의 전팀 반사실 A/B (읽기 전용).
 *
 * 같은 실 DB를 (A) HEAD 기본값, (B) 지정 제외 룰 off 로 각각 계산해
 * 팀별 score/completion/n 차이를 전수 출력한다. 시각·난수를 찍지 않아 재실행 시 동일.
 *   TOGGLE=<env 이름>  — off 로 내릴 제외 룰 (미지정이면 기본값만 출력)
 */
import { computeTeamScores } from '../../src/core/team-scorer.js';

const toggle = process.env.TOGGLE;
if (!toggle) throw new Error('TOGGLE required');

const prev = process.env[toggle];
delete process.env[toggle];
const on = await (computeTeamScores as any)();

process.env[toggle] = 'off';
const off = await (computeTeamScores as any)();
if (prev === undefined) delete process.env[toggle];
else process.env[toggle] = prev;

const byId = new Map(off.map((r: any) => [r.teamId, r]));
let changed = 0;
const lines: string[] = [];
for (const a of on) {
  const b: any = byId.get(a.teamId);
  if (!b) { lines.push(`MISSING_OFF ${a.teamId}`); continue; }
  if (a.score === b.score && a.completion === b.completion && a.n === b.n) continue;
  changed++;
  lines.push(
    `DIFF ${a.teamId} score ${b.score}->${a.score} completion ${b.completion}->${a.completion} ` +
    `n ${b.n}->${a.n} grade ${b.grade}->${a.grade} sample ${b.sample}->${a.sample}`,
  );
}
console.log(`toggle=${toggle} teams=${on.length} changed=${changed}`);
console.log(`maxN on=${on[0]?.maxN} off=${off[0]?.maxN}`);
for (const l of lines.sort()) console.log(l);

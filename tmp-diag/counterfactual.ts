import { computeTeamScores } from '../src/core/team-scorer.js';
function run(label: string) {
  const all = computeTeamScores();
  const t = all.find(x => x.teamId === 'team_gov-government-transparency')!;
  console.log(`${label}: score=${t.score} grade=${t.grade} completion=${t.completion}% n=${t.n} maxN=${t.maxN} sample=${t.sample} | zeroTeams=${all.filter(x=>x.completion===0).length}/${all.length}`);
}
run('GATE_ON (default)');
process.env.NCO_SCORER_AUDIT_APPROVAL_GATE = '0';
run('GATE_OFF (killswitch)');

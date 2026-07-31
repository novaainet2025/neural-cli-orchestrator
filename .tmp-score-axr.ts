import { computeTeamScores } from './src/core/team-scorer.js';
const all = computeTeamScores();
console.log(JSON.stringify(all.filter(s => s.teamId === 'team_ax-research'), null, 2));
console.log('teams total=', all.length, 'zero-completion=', all.filter(s => s.completionRate === 0).length);

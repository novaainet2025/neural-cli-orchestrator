import { computeTeamScores } from '../src/core/team-scorer.js';
const all = computeTeamScores();
const t = all.find(x => x.teamId === 'team_gov-government-transparency');
console.log('TARGET:', JSON.stringify(t));
const zero = all.filter(x => x.completion === 0);
console.log('teams total=', all.length, 'completion0=', zero.length);
console.log('top5:', all.slice().sort((a,b)=>b.score-a.score).slice(0,5).map(x=>`${x.slug}:${x.score}/${x.completion}%/n=${x.n}`).join(' | '));

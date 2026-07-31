import { computeTeamScores } from '../src/core/team-scorer.js';
const all: any[] = computeTeamScores() as any[];
const t = all.filter(s => JSON.stringify(s).includes('cli-experience') || JSON.stringify(s).includes('cli-design'));
console.log(JSON.stringify(t, null, 2));
console.log('teams total=', all.length, 'completion0=', all.filter(s => (s.completionRate ?? s.completion) === 0).length);

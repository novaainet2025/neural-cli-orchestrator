import { computeTeamScores } from '../src/core/team-scorer.js';
const r: any = await (computeTeamScores as any)();
const arr = Array.isArray(r) ? r : (r.teams ?? r.scores ?? r.rows ?? []);
if (!Array.isArray(arr)) { console.log('SHAPE=', Object.keys(r)); process.exit(0); }
const me = arr.find((t: any) => JSON.stringify(t).includes('gov-evolution-learning'));
console.log('GEL=', JSON.stringify(me, null, 1));
console.log('teams=', arr.length);

import { computeTeamScores } from '../src/core/team-scorer.js';
const all = computeTeamScores();
const t = all.filter((x: any) => JSON.stringify(x).includes('decision-coordination'));
console.log(JSON.stringify(t, null, 2));

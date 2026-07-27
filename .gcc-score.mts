import { computeTeamScores } from './src/core/team-scorer.js';
const rows: any[] = await (computeTeamScores as any)();
const r = rows.filter((x: any) => JSON.stringify(x).includes('gov-command-collaboration'));
console.log(JSON.stringify(r, null, 2));

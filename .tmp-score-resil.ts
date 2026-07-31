import { computeTeamScores } from './src/core/team-scorer.js';
const rows: any[] = computeTeamScores() as any;
console.log('keys=', Object.keys(rows[0] ?? {}).join(','));
const t = rows.find((r: any) => (r.teamId ?? r.id) === 'team_gov-assurance-resilience');
console.log('RESILIENCE:', JSON.stringify(t, null, 2));

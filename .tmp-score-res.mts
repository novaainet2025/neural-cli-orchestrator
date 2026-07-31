import Database from 'better-sqlite3';
import { computeTeamScores } from './src/core/team-scorer.ts';
const db = new Database('db/nco.db', { readonly: true });
const rows = computeTeamScores(db as any);
const t = rows.find(r => r.teamId === 'team_gov-assurance-resilience');
console.log('RESILIENCE:', JSON.stringify(t, null, 2));
const zero = rows.filter(r => (r as any).completionRate === 0);
console.log('teams total=', rows.length, 'completion0=', zero.length);

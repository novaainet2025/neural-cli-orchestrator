import Database from 'better-sqlite3';
import { computeTeamScores } from './src/core/team-scorer.js';
const db = new Database('db/nco.db', { readonly: true });
const scores = computeTeamScores(db as any);
console.log(JSON.stringify(scores.filter((s: any) => /cli/.test(s.teamId)), null, 2));

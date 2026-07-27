import { computeTeamScores } from './src/core/team-scorer.js';
import Database from 'better-sqlite3';
const db = new Database('/tmp/nco-dupaudit-c2.db', { readonly: true });
const rows = computeTeamScores(db as any).filter(r => String((r as any).teamId ?? (r as any).team_id ?? '').includes('evolution-learning'));
console.log(JSON.stringify(rows, null, 2));

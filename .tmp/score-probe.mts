import { computeTeamScores } from '../src/core/team-scorer.js';
import Database from 'better-sqlite3';
const db = new Database('db/nco.db', { readonly: true });
const scores = computeTeamScores(db);
const maxN = Math.max(...scores.map((s) => s.n));
console.log('teams', scores.length, 'maxN', maxN);
for (const s of scores) {
  if (['hr-director', 'gov-government-hr', 'gov-government-treasury', 'self-improvement'].includes(s.slug)) {
    console.log(JSON.stringify(s));
  }
}

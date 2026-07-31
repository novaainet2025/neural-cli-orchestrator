import Database from 'better-sqlite3';
import { computeTeamScores } from '../src/core/team-scorer.js';
const db = new Database('db/nco.db', { readonly: true });
const scores = computeTeamScores(db as any);
const t = scores.find((s) => s.teamId === 'team_ui-audit-approval');
console.log('TARGET', JSON.stringify(t));
console.log('teams=', scores.length, 'completion0=', scores.filter((s) => s.completion === 0).length);
const zero = scores.filter((s) => s.completion === 0).map((s) => `${s.slug}(n=${s.n},score=${s.score})`);
console.log('ZERO:', zero.join(' '));

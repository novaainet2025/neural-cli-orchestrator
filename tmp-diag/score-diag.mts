import Database from 'better-sqlite3';
import { computeTeamScores } from '../src/core/team-scorer.js';
const db = new Database('db/nco.db', { readonly: true });
const all = computeTeamScores(db as any);
const t = all.find(x => x.teamId === 'team_ax-decision-coordination-2026');
console.log('TEAM:', JSON.stringify(t));
console.log('teams total=', all.length, 'completion0=', all.filter(x=>x.completion===0).length);
console.log('top5:', all.slice().sort((a,b)=>b.score-a.score).slice(0,5).map(x=>`${x.slug}:${x.score}/${x.completion}%/n=${x.n}`).join(' | '));

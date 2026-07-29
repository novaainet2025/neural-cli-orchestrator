import Database from 'better-sqlite3';
import { computeTeamScores } from '/Users/nova-ai/project/nco/src/core/team-scorer.js';
const dbA = new Database('/Users/nova-ai/project/nco/db/nco.db', { readonly: true });
const dbB = new Database('/tmp/cq-cf.db', { readonly: true });
const pick = (rows: any[]) => rows.find(r => r.teamId === 'team_content-quality');
console.log('BASELINE (HEAD, patch NOT applied):', JSON.stringify(pick(computeTeamScores(dbA))));
console.log('COUNTERFACTUAL (cycle4 patch live):', JSON.stringify(pick(computeTeamScores(dbB))));

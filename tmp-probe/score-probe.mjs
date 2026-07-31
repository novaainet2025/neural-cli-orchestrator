const { computeTeamScores } = await import('../src/core/team-scorer.js');
const all = computeTeamScores();
const t = all.find(x => x.teamId === 'team_gov-assurance-resilience');
const zero = all.filter(x => x.completion === 0).length;
console.log(JSON.stringify({ gate: process.env.NCO_SCORER_AUDIT_APPROVAL_GATE ?? '(default:on)', team: t, teams: all.length, zeroCompletionTeams: zero }));

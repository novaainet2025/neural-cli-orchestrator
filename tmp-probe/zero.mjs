const { computeTeamScores } = await import('../src/core/team-scorer.js');
const all = computeTeamScores();
console.log(all.filter(x=>x.completion===0).map(x=>`${x.slug} score=${x.score} n=${x.n}/${x.sample}`).join('\n'));
const gov = all.filter(x=>x.organizationId==='org_nco-government').sort((a,b)=>a.score-b.score);
console.log('--- org_nco-government ---');
console.log(gov.map(x=>`${x.slug} ${x.score}/${x.grade} comp=${x.completion} n=${x.n}/${x.sample}`).join('\n'));

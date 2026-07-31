import { computeTeamScores } from '../src/core/team-scorer.js';
const arr: any = await (computeTeamScores as any)();
const zero = arr.filter((t: any) => t.completion === 0).length;
console.log('teams=', arr.length, 'zero_completion=', zero);
const v = 100*Math.log10(6)/Math.log10(19);
console.log('volume(n=6,maxN=19)=', v.toFixed(2));
console.log('score if completion=0 :', (0.9*0 + 0.1*v).toFixed(1));
console.log('score if completion=100:', (0.9*100 + 0.1*v).toFixed(1));

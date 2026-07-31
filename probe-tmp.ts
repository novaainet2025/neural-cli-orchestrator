import Database from 'better-sqlite3';
import fs from 'node:fs';
import { computeTeamScores } from './src/core/team-scorer.js';
const TEAM='team_ax-decision-coordination-2026';
const score=(db:any)=>{const r=computeTeamScores(db).find((t:any)=>t.teamId===TEAM);return r?`n=${r.n} completion=${r.completion} score=${r.score} sample=${r.sample}`:'NONE';};
const b=new Database('/tmp/nco-probe.db',{readonly:true});
console.log('baseline'.padEnd(34), score(b)); b.close();
for(const id of ['task_D854GB897-XUzouE','task_7kKfaizxOA4SMKw4','task_JO3bi-KKPfrdEdYK','task_-xLr2okwKANh3BPi']){
  const f=`/tmp/p-${id}.db`; fs.copyFileSync('/tmp/nco-probe.db',f);
  const d=new Database(f); d.prepare('DELETE FROM tasks WHERE id=?').run(id);
  console.log(('minus '+id).padEnd(34), score(d)); d.close(); fs.unlinkSync(f);
}

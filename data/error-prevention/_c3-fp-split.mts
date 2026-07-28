import Database from 'better-sqlite3';
import { CollaborationLoopGuard, collaborationChannelKey } from '../../src/security/collaboration-loop-guard.js';
const db = new Database('db/nco.db', { readonly: true });
const rows = db.prepare(`SELECT from_session,to_session,content,created_at FROM mesh_messages WHERE created_at >= datetime('now','-48 hours') ORDER BY created_at ASC`).all() as any[];
function parse(raw: string){const r=raw.trim();const iso=/[zZ]$|[+-]\d{2}:?\d{2}$/.test(r)?r.replace(' ','T'):r.replace(' ','T')+'Z';return Date.parse(iso);}
const realNow = Date.now;
function run(label:string, filter:(r:any)=>boolean){
  const g=new CollaborationLoopGuard(); const by:Record<string,number>={}; let n=0,blocked=0;
  for(const r of rows){ if(!filter(r)) continue; n++;
    const t=parse(r.created_at); (Date as any).now=()=>t;
    const d=g.check(collaborationChannelKey(r.from_session,r.to_session), r.content);
    if(!d.allowed){blocked++; by[d.rule!]=(by[d.rule!]??0)+1;}
  }
  (Date as any).now=realNow;
  console.log(`${label}: msgs=${n} blocked=${blocked} (${n?((blocked/n)*100).toFixed(2):0}%) ${JSON.stringify(by)}`);
}
run('to_session=unknown (catch-all sink)', r=>r.to_session==='unknown');
run('to_session<>unknown (real named channels)', r=>r.to_session!=='unknown');
db.close();

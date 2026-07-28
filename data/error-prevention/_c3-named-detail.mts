import Database from 'better-sqlite3';
import { CollaborationLoopGuard, collaborationChannelKey } from '../../src/security/collaboration-loop-guard.js';
const db = new Database('db/nco.db', { readonly: true });
const rows = db.prepare(`SELECT from_session,to_session,content,created_at FROM mesh_messages WHERE created_at >= datetime('now','-48 hours') AND to_session<>'unknown' ORDER BY created_at ASC`).all() as any[];
function parse(raw:string){const r=raw.trim();const iso=/[zZ]$|[+-]\d{2}:?\d{2}$/.test(r)?r.replace(' ','T'):r.replace(' ','T')+'Z';return Date.parse(iso);}
const realNow=Date.now; const g=new CollaborationLoopGuard();
for(const r of rows){const t=parse(r.created_at);(Date as any).now=()=>t;
  const d=g.check(collaborationChannelKey(r.from_session,r.to_session),r.content);
  if(!d.allowed) console.log(`${r.created_at} | ${d.rule} | ${r.from_session}->${r.to_session} | repeats=${d.repeats} win=${d.windowCount} | ${String(r.content).replace(/\s+/g,' ').slice(0,70)}`);}
(Date as any).now=realNow; db.close();

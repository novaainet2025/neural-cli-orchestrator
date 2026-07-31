import Database from 'better-sqlite3';
const db = new Database('db/nco.db',{readonly:true});
const TEAM='team_tech-port-02-safety-license';
const rows = db.prepare(`SELECT id, metadata_json, error, status,
  LENGTH(COALESCE(response,'')) as response_len,
  COALESCE(heartbeat_seq,0) as heartbeat_seq
  FROM tasks WHERE team_id=? AND created_at >= datetime('now','-48 hours')`).all(TEAM);
function parse(s){try{return JSON.parse(s)}catch{return{}}}
const retro=[];
for(const r of rows){
  const m=parse(r.metadata_json);
  const top=Array.isArray(m.attemptedAgents)?m.attemptedAgents:[];
  const hist=Array.isArray(m.escalationHistory)?m.escalationHistory:[];
  let maxH=[];
  for(const h of hist){const a=Array.isArray(h?.attemptedAgents)?h.attemptedAgents:[]; if(a.length>maxH.length)maxH=a;}
  if(maxH.length>0 && top.length<maxH.length){
    retro.push({id:r.id,status:r.status,top,hist:maxH,error:r.error,response_len:r.response_len,heartbeat_seq:r.heartbeat_seq});
  }
}
console.log('team02_retrograde_count='+retro.length);
console.log(JSON.stringify(retro,null,2));
db.close();

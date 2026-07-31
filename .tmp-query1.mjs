import Database from 'better-sqlite3';
const db = new Database('db/nco.db',{readonly:true});
const rows = db.prepare(`SELECT id, team_id, assigned_to, status, error,
  LENGTH(COALESCE(response,'')) as response_len,
  COALESCE(heartbeat_seq,0) as heartbeat_seq,
  created_at FROM tasks
  WHERE COALESCE(error,'') LIKE '%timeout(idle)%'
    AND LENGTH(COALESCE(response,'')) = 65536`).all();
console.log(JSON.stringify(rows,null,2));
db.close();

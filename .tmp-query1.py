import sqlite3, json
db = sqlite3.connect('db/nco.db')
db.row_factory = sqlite3.Row
rows = db.execute("""
SELECT id, team_id, assigned_to, status, error,
  LENGTH(COALESCE(response,'')) as response_len,
  COALESCE(heartbeat_seq,0) as heartbeat_seq,
  created_at FROM tasks
  WHERE COALESCE(error,'') LIKE '%timeout(idle)%'
    AND LENGTH(COALESCE(response,'')) = 65536
""").fetchall()
print(json.dumps([dict(r) for r in rows], indent=2))
db.close()

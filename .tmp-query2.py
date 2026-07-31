import sqlite3, json
TEAM = 'team_tech-port-02-safety-license'
db = sqlite3.connect('db/nco.db')
db.row_factory = sqlite3.Row
rows = db.execute("""
SELECT id, metadata_json, error, status,
  LENGTH(COALESCE(response,'')) as response_len,
  COALESCE(heartbeat_seq,0) as heartbeat_seq
  FROM tasks WHERE team_id=? AND created_at >= datetime('now','-48 hours')
""", (TEAM,)).fetchall()

def parse(s):
    try:
        return json.loads(s)
    except Exception:
        return {}

retro = []
for r in rows:
    m = parse(r['metadata_json'])
    top = m.get('attemptedAgents') if isinstance(m.get('attemptedAgents'), list) else []
    hist = m.get('escalationHistory') if isinstance(m.get('escalationHistory'), list) else []
    maxH = []
    for h in hist:
        a = h.get('attemptedAgents') if isinstance(h, dict) and isinstance(h.get('attemptedAgents'), list) else []
        if len(a) > len(maxH):
            maxH = a
    if len(maxH) > 0 and len(top) < len(maxH):
        retro.append({
            'id': r['id'], 'status': r['status'], 'top': top, 'hist': maxH,
            'error': r['error'], 'response_len': r['response_len'], 'heartbeat_seq': r['heartbeat_seq']
        })
print('team02_retrograde_count=' + str(len(retro)))
print(json.dumps(retro, indent=2))
db.close()

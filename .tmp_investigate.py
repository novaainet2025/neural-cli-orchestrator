import sqlite3, json
from datetime import datetime, timedelta, timezone
db=sqlite3.connect('file:db/nco.db?mode=ro', uri=True)
db.row_factory=sqlite3.Row
cur=db.cursor()
teams=cur.execute("""
SELECT id, slug, name, lead, is_active, status, last_score, last_checked_at
FROM teams
WHERE id LIKE '%evolution-skills%' OR slug LIKE '%evolution-skills%' OR name LIKE '%Skill Academy%'
""").fetchall()
print('TEAMS:')
for t in teams:
  print(dict(t))
team_ids=[t['id'] for t in teams]
if not team_ids:
  # fallback
  teams=cur.execute("SELECT id, slug, name FROM teams WHERE slug='gov-evolution-skills' OR id='team_gov-evolution-skills'").fetchall()
  print('FALLBACK TEAMS:', [dict(t) for t in teams])
  team_ids=[t['id'] for t in teams]
# members
for tid in team_ids:
  mems=cur.execute("SELECT member_type, member_ref FROM team_members WHERE team_id=? ORDER BY id", (tid,)).fetchall()
  print('MEMBERS', tid, [dict(m) for m in mems])

# schema columns for tasks
cols=cur.execute("PRAGMA table_info(tasks)").fetchall()
print('TASK_COLS:', [c['name'] for c in cols])

cutoff=(datetime.now(timezone.utc)-timedelta(hours=48)).strftime('%Y-%m-%d %H:%M:%S')
print('CUTOFF_UTC_LIKE', cutoff)
# try created_at filter - also try datetime('now','-48 hours')
for tid in team_ids:
  rows=cur.execute("""
    SELECT id, status, agent_id, assigned_to, error, created_at, completed_at, spawned_by_cli
    FROM tasks
    WHERE team_id=?
      AND datetime(created_at) >= datetime('now','-48 hours')
    ORDER BY created_at DESC
  """, (tid,)).fetchall()
  print(f'TASKS_48H count={len(rows)} team={tid}')
  for r in rows:
    print(dict(r))
  # status counts
  counts=cur.execute("""
    SELECT status, COUNT(*) c FROM tasks
    WHERE team_id=? AND datetime(created_at) >= datetime('now','-48 hours')
    GROUP BY status
  """, (tid,)).fetchall()
  print('STATUS_COUNTS', [dict(c) for c in counts])
  fails=cur.execute("""
    SELECT id, status, COALESCE(agent_id, assigned_to) as agent, error, created_at
    FROM tasks
    WHERE team_id=? AND datetime(created_at) >= datetime('now','-48 hours')
      AND status <> 'completed'
    ORDER BY created_at DESC
  """, (tid,)).fetchall()
  print('FAILURES:')
  for f in fails:
    d=dict(f)
    print('FAIL_ID', d['id'])
    print('FAIL_STATUS', d['status'])
    print('FAIL_AGENT', d['agent'])
    print('FAIL_ERROR_EXACT:', repr(d['error']))
    print('FAIL_CREATED', d['created_at'])
  # error pattern buckets
  buckets=cur.execute("""
    SELECT
      CASE
        WHEN error LIKE 'queue_wait_timeout%' THEN 'queue_wait_timeout'
        WHEN error LIKE 'orphaned:%' THEN 'orphaned'
        WHEN error LIKE 'provider_unavailable:%' THEN 'provider_unavailable'
        WHEN error LIKE 'Circuit breaker%' THEN 'circuit_breaker'
        WHEN error LIKE '%EPERM%' OR error LIKE '%read-only%' OR error LIKE '%Read-only%' THEN 'eperm_readonly'
        WHEN error LIKE '%context%' OR error LIKE '%token%' OR error LIKE '%MAX_OUTPUT%' OR error LIKE '%truncated%' OR error LIKE '%history truncated%' THEN 'context_windowish'
        WHEN error IS NULL OR error='' THEN 'null_error'
        ELSE 'other'
      END AS bucket,
      COUNT(*) c,
      group_concat(DISTINCT substr(error,1,120), ' || ') samples
    FROM tasks
    WHERE team_id=? AND datetime(created_at) >= datetime('now','-48 hours')
      AND status <> 'completed'
    GROUP BY 1
  """, (tid,)).fetchall()
  print('FAIL_BUCKETS:', [dict(b) for b in buckets])
  # hermes success rate all time / 48h by agent
  by_agent=cur.execute("""
    SELECT COALESCE(agent_id, assigned_to) agent,
           SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,
           SUM(CASE WHEN status<>'completed' THEN 1 ELSE 0 END) failed,
           COUNT(*) total
    FROM tasks
    WHERE team_id=? AND datetime(created_at) >= datetime('now','-48 hours')
    GROUP BY 1
  """, (tid,)).fetchall()
  print('BY_AGENT_48H', [dict(a) for a in by_agent])

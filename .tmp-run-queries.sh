#!/bin/sh
cd /Users/nova-ai/project/nco

echo "=== CMD 1 ==="
git status --short | head -80
echo "EXIT_CODE: $?"

echo "=== CMD 2 ==="
sqlite3 db/nco.db "SELECT id, slug, is_active FROM teams WHERE id='team_gov-command-collaboration' OR slug='gov-command-collaboration';"
echo "EXIT_CODE: $?"

echo "=== CMD 3 ==="
sqlite3 -header -column db/nco.db "
SELECT from_session, to_session, COUNT(*) AS n, COUNT(DISTINCT content) AS distinct_bodies
FROM mesh_messages
WHERE created_at >= datetime('now','-48 hours')
GROUP BY from_session, to_session
ORDER BY n DESC
LIMIT 15;
"
echo "EXIT_CODE: $?"

echo "=== CMD 4 ==="
sqlite3 -header -column db/nco.db "
SELECT from_session, to_session, substr(content,1,80) AS body_prefix, COUNT(*) AS repeats
FROM mesh_messages
WHERE created_at >= datetime('now','-48 hours')
GROUP BY from_session, to_session, content
HAVING repeats >= 4
ORDER BY repeats DESC
LIMIT 10;
"
echo "EXIT_CODE: $?"

echo "=== CMD 5 ==="
sqlite3 -header -column db/nco.db "
SELECT t.id, t.status, substr(COALESCE(t.error,''),1,120) AS err, t.completed_at, t.assigned_agent
FROM tasks t
JOIN team_task_links l ON l.task_id = t.id
WHERE l.team_id = 'team_gov-command-collaboration'
  AND COALESCE(t.completed_at, t.created_at) >= datetime('now','-48 hours')
ORDER BY COALESCE(t.completed_at, t.created_at) DESC
LIMIT 20;
"
echo "EXIT_CODE: $?"

echo "=== CMD 6 ==="
rg -n 'collaborationLoopGuard|checkCollaborationMessage' src/
echo "EXIT_CODE: $?"

echo "=== CMD 7 ==="
ls -la data/error-prevention/ data/self-improve/patches/ 08-IMPROVEMENTS/ 2>&1 | head -60
echo "EXIT_CODE: $?"

echo "=== CMD 8 ==="
rg -n 'PROVIDER_AUTH_EXCLUSION|buildProviderAuthExclusion' src/core/team-scorer.ts src/core/team-scorer.test.ts
echo "EXIT_CODE: $?"

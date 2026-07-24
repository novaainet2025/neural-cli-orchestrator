SELECT
  SUM(CASE WHEN status IN ('completed','failed','timed_out','lease_expired')
    AND NOT (COALESCE(error,'') LIKE 'orphaned:%')
    AND NOT (COALESCE(spawned_by_cli,'') = 'commander-perfgoal')
    THEN 1 ELSE 0 END) AS terminal_filtered,
  SUM(CASE WHEN status='completed'
    AND NOT (COALESCE(spawned_by_cli,'') = 'commander-perfgoal')
    THEN 1 ELSE 0 END) AS completed_filtered,
  SUM(CASE WHEN status IN ('completed','failed','timed_out','lease_expired') THEN 1 ELSE 0 END) AS terminal_raw,
  SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed_raw
FROM tasks
WHERE team_id='team_quality-audit'
  AND created_at >= datetime('2026-07-22 03:50:00')
  AND created_at < datetime('2026-07-24 03:50:00');

SELECT id, status, spawned_by_cli,
  acked_at IS NULL as ack_null,
  last_heartbeat_at IS NULL as hb_null,
  created_at, completed_at,
  CASE WHEN error LIKE 'orphaned:%' THEN 1 ELSE 0 END as orphaned,
  substr(COALESCE(error,''),1,100) as err
FROM tasks
WHERE team_id='team_quality-audit'
  AND created_at >= datetime('2026-07-22 03:50:00')
  AND created_at < datetime('2026-07-24 03:50:00')
  AND status IN ('completed','failed','timed_out','lease_expired','cancelled')
ORDER BY created_at;

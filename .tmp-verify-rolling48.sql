SELECT id, status, spawned_by_cli,
  CASE WHEN error LIKE 'orphaned:%' THEN 1 ELSE 0 END as orphaned,
  created_at
FROM tasks
WHERE team_id='team_quality-audit'
  AND julianday(created_at) >= julianday('now','-48 hours')
  AND status IN ('completed','failed','timed_out','lease_expired')
ORDER BY created_at;

SELECT
  SUM(CASE WHEN status IN ('completed','failed','timed_out','lease_expired') THEN 1 ELSE 0 END) raw_term,
  SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) raw_comp,
  SUM(CASE WHEN status IN ('completed','failed','timed_out','lease_expired')
    AND NOT (COALESCE(error,'') LIKE 'orphaned:%') THEN 1 ELSE 0 END) infra_term,
  SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) infra_comp,
  SUM(CASE WHEN status IN ('completed','failed','timed_out','lease_expired')
    AND NOT (COALESCE(error,'') LIKE 'orphaned:%')
    AND NOT (COALESCE(spawned_by_cli,'')='commander-perfgoal') THEN 1 ELSE 0 END) full_term,
  SUM(CASE WHEN status='completed'
    AND NOT (COALESCE(spawned_by_cli,'')='commander-perfgoal') THEN 1 ELSE 0 END) full_comp
FROM tasks
WHERE team_id='team_quality-audit'
  AND julianday(created_at) >= julianday('now','-48 hours')
  AND status IN ('completed','failed','timed_out','lease_expired');

SELECT id, status, spawned_by_cli, acked_at, last_heartbeat_at, heartbeat_seq,
  substr(COALESCE(prompt,''),1,200), substr(COALESCE(response,''),1,300), substr(COALESCE(error,''),1,200)
FROM tasks WHERE id='task_SMVL4-GzMPj56Wtg';

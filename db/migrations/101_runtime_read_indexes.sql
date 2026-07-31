-- 101: health/dashboard polling hot paths
--
-- /api/tasks enriches task rows with the latest active discussion. Without a
-- task_id index, every row scans the full discussions table (N+1 amplification).
CREATE INDEX IF NOT EXISTS idx_discussions_task_status_created
  ON discussions(task_id, status, created_at DESC);

-- Monitor/dashboard clients read the latest mesh messages repeatedly.
CREATE INDEX IF NOT EXISTS idx_mesh_messages_created
  ON mesh_messages(created_at DESC);

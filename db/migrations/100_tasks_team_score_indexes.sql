-- Team-score aggregation joins every active team to tasks by team_id.
-- Without a persistent index SQLite builds a large transient covering index
-- that includes response/metadata fields, blocking the Node event loop.
CREATE INDEX IF NOT EXISTS idx_tasks_team_status_created
  ON tasks(team_id, status, created_at);

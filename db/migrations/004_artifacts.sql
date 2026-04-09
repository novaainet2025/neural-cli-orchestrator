CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  artifact_type TEXT NOT NULL,
  path TEXT,
  content TEXT,
  review_status TEXT DEFAULT 'pending',
  reviewed_by TEXT,
  review_comment TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_artifacts_agent ON artifacts(agent_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_review ON artifacts(review_status);

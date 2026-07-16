CREATE TABLE IF NOT EXISTS decision_log (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  phase TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  evidence_tier TEXT,
  actor TEXT NOT NULL DEFAULT 'system',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decision_task
  ON decision_log(task_id);

CREATE INDEX IF NOT EXISTS idx_decision_created
  ON decision_log(created_at DESC);

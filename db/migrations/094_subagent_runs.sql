CREATE TABLE IF NOT EXISTS subagent_runs (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL,
  root_task_id TEXT,
  parent_provider TEXT NOT NULL,
  cli_session_id TEXT,
  spawned_by_cli TEXT,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'starting' CHECK(status IN ('starting','working','completed','failed','cancelled')),
  prompt_summary TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  source TEXT NOT NULL DEFAULT 'native' CHECK(source IN ('native','nco-task')),
  evidence_source TEXT,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent ON subagent_runs(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_status ON subagent_runs(status);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_root ON subagent_runs(root_task_id);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_updated ON subagent_runs(updated_at DESC);

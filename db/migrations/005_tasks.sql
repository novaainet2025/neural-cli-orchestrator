CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'task',
  prompt TEXT NOT NULL,
  system_prompt TEXT,
  assigned_to TEXT,
  delegated_from TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','assigned','running','streaming','reviewing','completed','failed','cancelled')),
  progress REAL DEFAULT 0,
  result_json TEXT,
  response TEXT,
  error TEXT,
  workspace_id TEXT DEFAULT 'default',
  parent_task_id TEXT,
  priority INTEGER DEFAULT 0,
  metadata_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);

ALTER TABLE tasks ADD COLUMN acked_at TEXT;
ALTER TABLE tasks ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE tasks ADD COLUMN heartbeat_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN lease_expires_at TEXT;

PRAGMA foreign_keys=OFF;
CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'task',
  prompt TEXT NOT NULL,
  system_prompt TEXT,
  assigned_to TEXT,
  delegated_from TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','queued','assigned','running','streaming','reviewing','completed','failed','timed_out','cancelled','lease_expired')),
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
  completed_at TEXT,
  spawned_by_cli TEXT,
  verifier_json TEXT,
  verifier_result_json TEXT,
  last_activity_at TEXT,
  evidence_json TEXT,
  orphan_requeue_count INTEGER NOT NULL DEFAULT 0,
  team_id TEXT REFERENCES teams(id),
  acked_at TEXT,
  last_heartbeat_at TEXT,
  heartbeat_seq INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT
);
INSERT INTO tasks_new (
  id, mode, prompt, system_prompt, assigned_to, delegated_from, status, progress,
  result_json, response, error, workspace_id, parent_task_id, priority, metadata_json,
  created_at, updated_at, completed_at, spawned_by_cli, verifier_json, verifier_result_json,
  last_activity_at, evidence_json, orphan_requeue_count, team_id, acked_at,
  last_heartbeat_at, heartbeat_seq, lease_expires_at
)
SELECT
  id, mode, prompt, system_prompt, assigned_to, delegated_from, status, progress,
  result_json, response, error, workspace_id, parent_task_id, priority, metadata_json,
  created_at, updated_at, completed_at, spawned_by_cli, verifier_json, verifier_result_json,
  last_activity_at, evidence_json, orphan_requeue_count, team_id, acked_at,
  last_heartbeat_at, COALESCE(heartbeat_seq, 0), lease_expires_at
FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(status, lease_expires_at);
PRAGMA foreign_keys=ON;

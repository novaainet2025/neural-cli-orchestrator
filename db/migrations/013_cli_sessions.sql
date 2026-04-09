-- CLI Session tracking for multi-instance coordination
CREATE TABLE IF NOT EXISTS cli_sessions (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  pid INTEGER NOT NULL,
  user_name TEXT,
  project_dir TEXT,
  cli_version TEXT,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','idle','busy','disconnected')),
  current_file TEXT,
  current_task TEXT,
  working_files_json TEXT DEFAULT '[]',
  metadata_json TEXT,
  registered_at TEXT DEFAULT (datetime('now')),
  last_heartbeat TEXT DEFAULT (datetime('now')),
  disconnected_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cli_sessions_status ON cli_sessions(status);
CREATE INDEX IF NOT EXISTS idx_cli_sessions_heartbeat ON cli_sessions(last_heartbeat);

-- Track which CLI spawned which task
ALTER TABLE tasks ADD COLUMN spawned_by_cli TEXT;

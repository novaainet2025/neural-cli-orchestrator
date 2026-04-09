CREATE TABLE IF NOT EXISTS rate_limit_state (
  agent_id TEXT PRIMARY KEY,
  is_limited INTEGER DEFAULT 0,
  reason TEXT,
  limited_at TEXT,
  reset_at TEXT,
  consecutive_failures INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS file_locks (
  path TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  acquired_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  metric_type TEXT NOT NULL,
  value REAL NOT NULL,
  metadata_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_metrics ON metrics(agent_id, metric_type, created_at DESC);

CREATE TABLE IF NOT EXISTS handoff_packets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  sender TEXT,
  outcome TEXT NOT NULL,
  summary TEXT,
  packet_json TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  reject_reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

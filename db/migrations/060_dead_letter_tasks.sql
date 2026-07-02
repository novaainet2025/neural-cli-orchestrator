CREATE TABLE IF NOT EXISTS dead_letter_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  ai TEXT,
  prompt TEXT,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

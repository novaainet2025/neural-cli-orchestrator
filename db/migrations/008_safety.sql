-- ═══ Phase A: Safety — FileChangeGuard + VerificationGate ═══

-- File backup records (created by FileChangeGuard when change ratio >= 70%)
CREATE TABLE IF NOT EXISTS file_backups (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  file_path TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  change_ratio REAL NOT NULL DEFAULT 0,
  original_size INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_backups_task ON file_backups(task_id);
CREATE INDEX IF NOT EXISTS idx_backups_agent ON file_backups(agent_id, created_at DESC);

-- Verification gate results (L1 typecheck, L2 lint, L3 change ratio)
CREATE TABLE IF NOT EXISTS verification_gates (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  gate_level TEXT NOT NULL,
  status TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gates_task ON verification_gates(task_id);

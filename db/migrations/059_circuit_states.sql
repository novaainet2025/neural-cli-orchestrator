CREATE TABLE IF NOT EXISTS circuit_states (
  agent_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  opened_at INTEGER,
  cooldown_until INTEGER,
  reason TEXT
);

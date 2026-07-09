-- Nova Government — Environment & Energy Log
-- ENVIRONMENT-POLICY.md v2.0 구현
-- 2026-06-18

CREATE TABLE IF NOT EXISTS nova_energy_log (
  id TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  energy_wh REAL NOT NULL,
  co2_grams REAL NOT NULL,
  action_type TEXT DEFAULT 'inference',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_energy_log_did ON nova_energy_log(did);
CREATE INDEX IF NOT EXISTS idx_energy_log_created ON nova_energy_log(created_at);

CREATE TABLE IF NOT EXISTS nova_quota_exceptions (
  id TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at INTEGER NOT NULL
);

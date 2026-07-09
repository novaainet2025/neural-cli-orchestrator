CREATE TABLE IF NOT EXISTS nova_privacy_settings (
  did TEXT PRIMARY KEY,
  consent_level INTEGER DEFAULT 0,
  erasure_requested_at INTEGER,
  erasure_completed_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nova_consent_log (
  id TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  action TEXT NOT NULL,
  old_level INTEGER,
  new_level INTEGER,
  created_at INTEGER NOT NULL
);

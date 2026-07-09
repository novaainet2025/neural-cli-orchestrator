CREATE TABLE IF NOT EXISTS nova_citizen_activities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_did   TEXT NOT NULL,
  activity_type TEXT NOT NULL CHECK(activity_type IN ('post','comment','like','vote','governance')),
  weight        REAL NOT NULL DEFAULT 1.0,
  metadata      TEXT DEFAULT '{}',
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  processed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_activities_citizen ON nova_citizen_activities(citizen_did, created_at);
CREATE INDEX IF NOT EXISTS idx_activities_unprocessed ON nova_citizen_activities(processed_at) WHERE processed_at IS NULL;
ALTER TABLE nova_citizens ADD COLUMN reactivation_requested_at INTEGER;

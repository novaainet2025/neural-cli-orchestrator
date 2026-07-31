CREATE TABLE IF NOT EXISTS provider_assignment_policies (
  scope_type TEXT NOT NULL CHECK(scope_type IN ('organization', 'team')),
  scope_id TEXT NOT NULL,
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS provider_assignment_snapshots (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('organization', 'team')),
  scope_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('assigned', 'unassigned')),
  primary_provider_id TEXT,
  provider_ids_json TEXT NOT NULL CHECK(json_valid(provider_ids_json)),
  policy_fingerprint TEXT NOT NULL,
  provider_config_fingerprint TEXT NOT NULL,
  availability_fingerprint TEXT NOT NULL,
  reason TEXT NOT NULL,
  candidates_json TEXT NOT NULL CHECK(json_valid(candidates_json)),
  created_at TEXT NOT NULL,
  valid_until TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_assignment_events (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL
    REFERENCES provider_assignment_snapshots(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  from_provider_id TEXT,
  to_provider_id TEXT,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(evidence_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_provider_assignment_policies_updated
  ON provider_assignment_policies(scope_type, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_provider_assignment_snapshots_scope_created
  ON provider_assignment_snapshots(scope_type, scope_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_provider_assignment_snapshots_validity
  ON provider_assignment_snapshots(valid_until, status);

CREATE INDEX IF NOT EXISTS idx_provider_assignment_events_assignment_created
  ON provider_assignment_events(assignment_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_provider_assignment_events_task
  ON provider_assignment_events(task_id, created_at ASC)
  WHERE task_id IS NOT NULL;

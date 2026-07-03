CREATE TABLE IF NOT EXISTS acquisitions (
  id TEXT PRIMARY KEY,
  package_name TEXT NOT NULL,
  version TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT,
  discovered_from_json TEXT NOT NULL,
  vet_results_json TEXT NOT NULL,
  decision TEXT NOT NULL,
  decision_reason TEXT NOT NULL,
  approval_state TEXT NOT NULL DEFAULT 'none',
  installed_path TEXT,
  package_sha256 TEXT,
  manifest_sha256 TEXT,
  installed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_acq_pkg_ver ON acquisitions(package_name, version);
CREATE INDEX IF NOT EXISTS idx_acq_decision ON acquisitions(decision, created_at DESC);

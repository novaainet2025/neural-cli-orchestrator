-- Durable company/harness orchestration state.
-- 019_harness.sql existed in an older history but is not present in fresh installs,
-- so recreate its report table idempotently here as well.
CREATE TABLE IF NOT EXISTS harness_reports (
  id                TEXT PRIMARY KEY,
  requirement       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'completed',
  total_iterations  INTEGER NOT NULL DEFAULT 1,
  final_avg_score   REAL NOT NULL DEFAULT 0,
  report_json       TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_harness_reports_created
  ON harness_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_harness_reports_status
  ON harness_reports(status);

CREATE TABLE IF NOT EXISTS company_runs (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  org_slug    TEXT NOT NULL,
  goal        TEXT NOT NULL,
  mode        TEXT NOT NULL,
  status      TEXT NOT NULL,
  dry_run     INTEGER NOT NULL DEFAULT 0,
  project_dir TEXT NOT NULL,
  run_json    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_company_runs_status_updated
  ON company_runs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_company_runs_org_created
  ON company_runs(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS harness_runs (
  id             TEXT PRIMARY KEY,
  requirement    TEXT NOT NULL,
  organization   TEXT NOT NULL,
  mode           TEXT NOT NULL,
  status         TEXT NOT NULL,
  company_run_id TEXT,
  config_json    TEXT NOT NULL DEFAULT '{}',
  report_json    TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  completed_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_harness_runs_status_updated
  ON harness_runs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_harness_runs_company
  ON harness_runs(company_run_id);

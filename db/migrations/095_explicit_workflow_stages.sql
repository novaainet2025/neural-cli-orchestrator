-- Durable, explicit team/company workflow state.
-- One run can cover one team or every team in a company run.  Stage rows keep
-- the full history instead of overwriting a single "current stage" column.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id                  TEXT PRIMARY KEY,
  root_task_id        TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  team_id             TEXT REFERENCES teams(id) ON DELETE SET NULL,
  company_run_id      TEXT,
  source              TEXT NOT NULL DEFAULT 'task-intake',
  policy              TEXT NOT NULL CHECK(policy IN ('required', 'routine', 'explicit')),
  status              TEXT NOT NULL DEFAULT 'pending'
                              CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  prompt              TEXT NOT NULL,
  complexity          INTEGER NOT NULL DEFAULT 0,
  policy_reason       TEXT NOT NULL,
  metadata_json       TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT
);

CREATE TABLE IF NOT EXISTS workflow_stages (
  id                  TEXT PRIMARY KEY,
  workflow_run_id     TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  team_id             TEXT REFERENCES teams(id) ON DELETE SET NULL,
  stage               TEXT NOT NULL
                              CHECK(stage IN ('discussion', 'design', 'implementation', 'review', 'verification')),
  ordinal             INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 5),
  status              TEXT NOT NULL DEFAULT 'pending'
                              CHECK(status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'cancelled')),
  required            INTEGER NOT NULL DEFAULT 1 CHECK(required IN (0, 1)),
  task_id             TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  discussion_id       TEXT REFERENCES discussions(id) ON DELETE SET NULL,
  executor            TEXT,
  skip_reason         TEXT,
  error               TEXT,
  evidence_json       TEXT NOT NULL DEFAULT '{}',
  started_at          TEXT,
  completed_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_stage_identity
  ON workflow_stages(workflow_run_id, IFNULL(team_id, ''), stage);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_team_updated
  ON workflow_runs(team_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_company_updated
  ON workflow_runs(company_run_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_stages_team_status
  ON workflow_stages(team_id, stage, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_stages_task
  ON workflow_stages(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_stages_discussion
  ON workflow_stages(discussion_id) WHERE discussion_id IS NOT NULL;

ALTER TABLE tasks ADD COLUMN workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN workflow_stage TEXT
  CHECK(workflow_stage IN ('discussion', 'design', 'implementation', 'review', 'verification'));

ALTER TABLE discussions ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE discussions ADD COLUMN company_run_id TEXT;
ALTER TABLE discussions ADD COLUMN workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_workflow_stage
  ON tasks(workflow_run_id, workflow_stage, status);
CREATE INDEX IF NOT EXISTS idx_discussions_team_updated
  ON discussions(team_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_discussions_workflow
  ON discussions(workflow_run_id, status, updated_at DESC);

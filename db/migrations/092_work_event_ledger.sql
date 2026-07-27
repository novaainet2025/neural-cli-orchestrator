-- 092: Unified, append-only work event ledger.
--
-- This is the durable source for operational learning. It intentionally keeps
-- event history immutable while export checkpoints live in a separate table.
CREATE TABLE IF NOT EXISTS work_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  source_event_id TEXT,
  category TEXT NOT NULL CHECK(category IN (
    'work', 'success', 'failure', 'improvement', 'context', 'issue',
    'conflict', 'error', 'bug', 'worktree', 'git', 'regression'
  )),
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN (
    'debug', 'info', 'warning', 'error', 'critical'
  )),
  outcome TEXT NOT NULL DEFAULT 'observed' CHECK(outcome IN (
    'observed', 'started', 'succeeded', 'failed', 'blocked', 'cancelled'
  )),
  title TEXT NOT NULL,
  summary TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  task_id TEXT,
  work_report_id TEXT,
  improvement_note_id TEXT,
  agent_id TEXT,
  session_id TEXT,
  project_path TEXT,
  worktree_path TEXT,
  branch TEXT,
  commit_sha TEXT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  previous_hash TEXT,
  content_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_events_occurred
  ON work_events(occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_work_events_category
  ON work_events(category, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_events_task
  ON work_events(task_id, occurred_at ASC)
  WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_events_session
  ON work_events(session_id, occurred_at ASC)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_events_source
  ON work_events(source, source_event_id);

CREATE TABLE IF NOT EXISTS work_event_export_state (
  target_key TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  target_path TEXT NOT NULL,
  exported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS work_event_source_state (
  source_key TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The ledger is append-only. Corrections are new events that reference the
-- superseded event in detail_json; mutation and deletion are rejected.
CREATE TRIGGER IF NOT EXISTS trg_work_events_no_update
BEFORE UPDATE ON work_events
BEGIN
  SELECT RAISE(ABORT, 'work_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_work_events_no_delete
BEFORE DELETE ON work_events
BEGIN
  SELECT RAISE(ABORT, 'work_events is append-only');
END;

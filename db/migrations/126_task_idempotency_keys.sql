-- Caller-scoped task submission idempotency must be atomic. JSON lookups on
-- tasks cannot prevent two concurrent requests from both passing a SELECT
-- before either INSERT commits, so reserve the key in the same transaction as
-- the task row. The request fingerprint also prevents accidental key reuse for
-- a different provider/model/prompt/deadline contract.
CREATE TABLE IF NOT EXISTS task_idempotency_keys (
  caller_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (caller_scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_task_idempotency_task_id
  ON task_idempotency_keys(task_id);

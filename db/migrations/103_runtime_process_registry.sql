-- Durable ownership for detached provider processes. If the backend exits
-- without running its shutdown handlers, the next backend instance can reap
-- only processes whose PID, process group, and command fingerprint still match.
CREATE TABLE IF NOT EXISTS runtime_processes (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  process_group_id INTEGER NOT NULL,
  owner_pid INTEGER NOT NULL,
  command_hash TEXT NOT NULL,
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runtime_processes_owner
  ON runtime_processes(owner_pid, registered_at);

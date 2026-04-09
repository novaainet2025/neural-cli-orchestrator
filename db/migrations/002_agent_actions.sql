CREATE TABLE IF NOT EXISTS agent_actions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target TEXT,
  detail_json TEXT,
  task_id TEXT,
  session_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_actions_agent ON agent_actions(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_actions_task ON agent_actions(task_id);
CREATE INDEX IF NOT EXISTS idx_actions_type ON agent_actions(action_type);

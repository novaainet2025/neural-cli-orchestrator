CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  content TEXT NOT NULL,
  message_type TEXT DEFAULT 'direct',
  priority TEXT DEFAULT 'normal',
  artifact_id TEXT,
  session_id TEXT,
  read_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_from ON agent_messages(from_agent);
CREATE INDEX IF NOT EXISTS idx_messages_to ON agent_messages(to_agent);
CREATE INDEX IF NOT EXISTS idx_messages_session ON agent_messages(session_id);

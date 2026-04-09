-- ═══ Phase B: Agent Session Management ═══

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT DEFAULT 'running' CHECK(status IN ('running','completed','failed','aborted')),
  iterations INTEGER DEFAULT 0,
  tool_calls INTEGER DEFAULT 0,
  artifacts_json TEXT DEFAULT '[]',
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON agent_sessions(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON agent_sessions(status);

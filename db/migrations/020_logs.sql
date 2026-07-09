-- ═══ Phase C: Structured Observability Logs ═══

CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  timestamp TEXT DEFAULT (datetime('now')),
  level TEXT NOT NULL CHECK(level IN ('debug', 'info', 'warn', 'error', 'fatal')),
  session_id TEXT,
  agent_id TEXT,
  category TEXT, -- e.g., 'task', 'invocation', 'system', 'security'
  message TEXT NOT NULL,
  context_json TEXT, -- For structured data (error details, task IDs, etc.)
  status TEXT, -- e.g., 'success', 'failure', 'pending'
  
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_session ON logs(session_id);
CREATE INDEX IF NOT EXISTS idx_logs_agent ON logs(agent_id);
CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category);

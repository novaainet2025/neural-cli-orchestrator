-- ═══ CLI Mesh — Inter-agent awareness & messaging ═══

CREATE TABLE IF NOT EXISTS mesh_sessions (
  session_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  pid INTEGER,
  status TEXT DEFAULT 'idle',
  current_work TEXT DEFAULT '',
  current_files_json TEXT DEFAULT '[]',
  branch TEXT DEFAULT 'unknown',
  started_at TEXT DEFAULT (datetime('now')),
  last_heartbeat TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mesh_agent ON mesh_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_mesh_heartbeat ON mesh_sessions(last_heartbeat);

CREATE TABLE IF NOT EXISTS mesh_messages (
  id TEXT PRIMARY KEY,
  from_session TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_session TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'info',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mesh_msg_to ON mesh_messages(to_session, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mesh_msg_from ON mesh_messages(from_session, created_at DESC);

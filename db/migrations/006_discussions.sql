CREATE TABLE IF NOT EXISTS discussions (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  mode TEXT DEFAULT 'discussion',
  status TEXT DEFAULT 'active',
  participants_json TEXT NOT NULL,
  initiator TEXT NOT NULL,
  current_round INTEGER DEFAULT 0,
  max_rounds INTEGER DEFAULT 3,
  consensus_threshold REAL DEFAULT 0.8,
  consensus_rate REAL DEFAULT 0,
  result_json TEXT,
  report TEXT,
  task_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS discussion_messages (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  round INTEGER,
  message_type TEXT DEFAULT 'proposal',
  content TEXT NOT NULL,
  scores_json TEXT,
  vote_choice TEXT,
  vote_reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_disc_msgs ON discussion_messages(discussion_id, round);

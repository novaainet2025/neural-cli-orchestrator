-- ═══ Phase E: Knowledge Base (Learn) ═══

CREATE TABLE IF NOT EXISTS knowledge_base (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('bug_pattern','architecture','convention','decision')),
  content TEXT NOT NULL,
  source_task_id TEXT,
  source_discussion_id TEXT,
  confidence REAL DEFAULT 0.8,
  used_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_kb_project ON knowledge_base(project_path);
CREATE INDEX IF NOT EXISTS idx_kb_category ON knowledge_base(category);

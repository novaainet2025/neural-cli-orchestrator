-- ═══ Update Knowledge Base for Obsidian integration ═══

-- 1. Create a temporary table with the new check constraint and embedding_json column
CREATE TABLE knowledge_base_new (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('bug_pattern','architecture','convention','decision','obsidian')),
  content TEXT NOT NULL,
  source_task_id TEXT,
  source_discussion_id TEXT,
  confidence REAL DEFAULT 0.8,
  used_count INTEGER DEFAULT 0,
  embedding_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 2. Copy data from the old table to the new one
INSERT INTO knowledge_base_new (
  id, project_path, category, content, source_task_id, source_discussion_id, 
  confidence, used_count, created_at, updated_at
)
SELECT 
  id, project_path, category, content, source_task_id, source_discussion_id, 
  confidence, used_count, created_at, updated_at
FROM knowledge_base;

-- 3. Drop the old table
DROP TABLE knowledge_base;

-- 4. Rename the new table to knowledge_base
ALTER TABLE knowledge_base_new RENAME TO knowledge_base;

-- 5. Re-create indexes
CREATE INDEX idx_kb_project ON knowledge_base(project_path);
CREATE INDEX idx_kb_category ON knowledge_base(category);

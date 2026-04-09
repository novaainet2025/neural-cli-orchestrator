-- ═══ Phase D: Plans + Kanban ═══

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  markdown_path TEXT NOT NULL,
  source_discussion_id TEXT,
  status TEXT DEFAULT 'draft' CHECK(status IN ('draft','active','completed','archived')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kanban_tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT REFERENCES plans(id),
  title TEXT NOT NULL,
  description TEXT,
  column_status TEXT DEFAULT 'todo' CHECK(column_status IN ('todo','in_progress','review','done')),
  assigned_to TEXT,
  order_index INTEGER DEFAULT 0,
  depends_on_json TEXT DEFAULT '[]',
  execution_type TEXT DEFAULT 'sequential' CHECK(execution_type IN ('sequential','parallel')),
  task_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_kanban_plan ON kanban_tasks(plan_id);
CREATE INDEX IF NOT EXISTS idx_kanban_status ON kanban_tasks(column_status);

CREATE TABLE IF NOT EXISTS nova_research_projects (
  id TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  title TEXT NOT NULL,
  abstract TEXT,
  research_type TEXT DEFAULT 'basic',
  status TEXT DEFAULT 'active',
  open_source_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nova_research_grants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  did TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  approved_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nova_patents (
  id TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  project_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

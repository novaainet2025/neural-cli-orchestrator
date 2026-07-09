-- 023: Dynamic company definitions for conductor
CREATE TABLE IF NOT EXISTS company_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  roles TEXT NOT NULL DEFAULT '[]',   -- JSON: [{role, agentId, instruction}]
  prompt_keywords TEXT DEFAULT '',    -- CSV of trigger words for auto-routing
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_company_definitions_active ON company_definitions(is_active);

-- Trigger to auto-update updated_at
CREATE TRIGGER IF NOT EXISTS company_definitions_updated_at
  AFTER UPDATE ON company_definitions
  BEGIN
    UPDATE company_definitions SET updated_at = datetime('now') WHERE id = NEW.id;
  END;

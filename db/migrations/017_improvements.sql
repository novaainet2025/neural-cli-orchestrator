-- Phase 4: 개선노트 (Improvement Notes)
CREATE TABLE IF NOT EXISTS improvement_notes (
  id TEXT PRIMARY KEY,
  timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  category TEXT NOT NULL DEFAULT 'general',
  -- category: 'tooling' | 'proxy' | 'agent' | 'ui' | 'general'
  problem TEXT NOT NULL,
  root_cause TEXT NOT NULL DEFAULT '',
  fix TEXT NOT NULL DEFAULT '',
  verified_at DATETIME,
  agent TEXT NOT NULL DEFAULT 'unknown',
  severity TEXT NOT NULL DEFAULT 'medium',
  -- severity: 'low' | 'medium' | 'high' | 'critical'
  tags TEXT NOT NULL DEFAULT '[]'  -- JSON array of string tags
);

CREATE INDEX IF NOT EXISTS idx_improvement_category ON improvement_notes(category);
CREATE INDEX IF NOT EXISTS idx_improvement_severity ON improvement_notes(severity);
CREATE INDEX IF NOT EXISTS idx_improvement_timestamp ON improvement_notes(timestamp DESC);

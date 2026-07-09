-- 028: Skills, Plugins, Backups tables

-- ── Skills (동적 파이프라인 스킬) ─────────────────────────
CREATE TABLE IF NOT EXISTS skills (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL DEFAULT '',
  trigger_keywords TEXT NOT NULL DEFAULT '[]',  -- JSON array
  pipeline     TEXT NOT NULL DEFAULT '[]',      -- JSON: [{step,agentId,promptTemplate}]
  enabled      INTEGER NOT NULL DEFAULT 1,
  usage_count  INTEGER NOT NULL DEFAULT 0,
  avg_quality  REAL NOT NULL DEFAULT 0.0,
  auto_generated INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Plugins (인라인 코드 플러그인) ───────────────────────
CREATE TABLE IF NOT EXISTS plugins (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL DEFAULT '',
  version      TEXT NOT NULL DEFAULT '1.0.0',
  code         TEXT NOT NULL DEFAULT '',        -- 인라인 JS 코드
  exports      TEXT NOT NULL DEFAULT '[]',      -- JSON: ["functionName",...]
  dependencies TEXT NOT NULL DEFAULT '[]',      -- JSON: ["pkg@ver",...]
  enabled      INTEGER NOT NULL DEFAULT 1,
  load_count   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Backups (스냅샷 메타데이터) ──────────────────────────
CREATE TABLE IF NOT EXISTS backups (
  id           TEXT PRIMARY KEY,
  filename     TEXT NOT NULL,
  path         TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  description  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

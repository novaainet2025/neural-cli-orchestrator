-- Phase 2: CLI 세션 간 작업 위임 테이블
CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  from_session_id TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  to_session_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  acceptance_status TEXT DEFAULT 'pending'
    CHECK(acceptance_status IN ('pending','accepted','rejected','expired')),
  work_status TEXT DEFAULT 'waiting'
    CHECK(work_status IN ('waiting','in_progress','completed','failed','cancelled')),
  progress_pct INTEGER DEFAULT 0,
  progress_note TEXT,
  result TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  accepted_at TEXT,
  completed_at TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deleg_from ON delegations(from_session_id);
CREATE INDEX IF NOT EXISTS idx_deleg_to ON delegations(to_session_id, acceptance_status);
CREATE INDEX IF NOT EXISTS idx_deleg_status ON delegations(work_status, acceptance_status);

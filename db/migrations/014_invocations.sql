-- Phase 1: 에이전트 호출 추적 테이블
-- 어떤 CLI 세션이 어떤 에이전트를 호출했는지 + 완료 결과 기록
CREATE TABLE IF NOT EXISTS agent_invocations (
  id TEXT PRIMARY KEY,
  caller_session_id TEXT NOT NULL,
  caller_agent_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  target_task_id TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','cancelled')),
  prompt TEXT,
  result_summary TEXT,
  error TEXT,
  mode TEXT DEFAULT 'task',
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  notified INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invoc_caller ON agent_invocations(caller_session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoc_target ON agent_invocations(target_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_invoc_task ON agent_invocations(target_task_id);

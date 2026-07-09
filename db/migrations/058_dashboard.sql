-- NCO Dashboard: 에이전트 평가 + 학습 이벤트 테이블
CREATE TABLE IF NOT EXISTS agent_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  score INTEGER,
  success INTEGER DEFAULT 0,
  duration_ms INTEGER,
  error_type TEXT,
  improvement_note TEXT,
  evaluated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS learning_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  event_type TEXT,
  pattern TEXT,
  context TEXT,
  auto_applied INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_evals_agent ON agent_evaluations(agent_id);
CREATE INDEX IF NOT EXISTS idx_learning_agent ON learning_events(agent_id);

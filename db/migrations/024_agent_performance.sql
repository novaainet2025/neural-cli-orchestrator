-- 024: Agent performance tracking for Mithosis-level adaptive routing
CREATE TABLE IF NOT EXISTS agent_performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'general',  -- general/code/design/review/verify/research/ui/media
  success INTEGER NOT NULL DEFAULT 1,          -- 1=success, 0=fail
  quality_score REAL NOT NULL DEFAULT 0,       -- 0-100 from QualityGate
  output_length INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  prompt_hash TEXT,                            -- sha1(prompt) for dedup
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_perf_lookup ON agent_performance(agent_id, task_type, created_at DESC);

-- Benchmark results table
CREATE TABLE IF NOT EXISTS benchmark_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  test_name TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  output_preview TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_benchmark_run ON benchmark_results(run_id, agent_id);

-- Materialized view: per-agent, per-task_type aggregate (refreshed by trigger)
CREATE TABLE IF NOT EXISTS agent_performance_summary (
  agent_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  total_runs INTEGER NOT NULL DEFAULT 0,
  success_rate REAL NOT NULL DEFAULT 0,   -- 0-1
  avg_quality REAL NOT NULL DEFAULT 0,    -- 0-100
  avg_duration_ms REAL NOT NULL DEFAULT 0,
  p95_quality REAL NOT NULL DEFAULT 0,
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, task_type)
);

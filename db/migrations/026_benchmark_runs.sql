-- 벤치마크 실행 요약 테이블
CREATE TABLE IF NOT EXISTS benchmark_runs (
  run_id       TEXT PRIMARY KEY,
  overall_score REAL NOT NULL DEFAULT 0,
  mithosis_gap  REAL NOT NULL DEFAULT 0,
  agent_count   INTEGER NOT NULL DEFAULT 0,
  test_count    INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 기존 benchmark_results 에 keyword 컬럼 추가 (없을 수도 있으므로 idempotent)
ALTER TABLE benchmark_results ADD COLUMN keyword_hits  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE benchmark_results ADD COLUMN keyword_total INTEGER NOT NULL DEFAULT 0;

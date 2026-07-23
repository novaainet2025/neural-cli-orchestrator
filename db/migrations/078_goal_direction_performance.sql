-- 078: (1) 감소형 목표 지원 direction, (2) 성과보고 저장 performance_reports
-- direction='decrease'는 "80→35처럼 줄이는" 목표. 달성률 공식이 방향을 반영한다.

ALTER TABLE team_goals ADD COLUMN direction TEXT NOT NULL DEFAULT 'increase';  -- 'increase' | 'decrease'

CREATE TABLE IF NOT EXISTS performance_reports (
  id           TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL,                       -- 'organization' | 'team'
  subject_id   TEXT NOT NULL,
  period       TEXT NOT NULL DEFAULT 'daily',        -- 'daily' | 'weekly' | 'monthly'
  period_key   TEXT NOT NULL,
  metrics_json TEXT,                                 -- 자동 지표 스냅샷(성공률/태스크수/목표달성%)
  reflection   TEXT,                                 -- 반성
  improvement  TEXT,                                 -- 개선안
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_perf_reports_subject ON performance_reports(subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS idx_perf_reports_period  ON performance_reports(period, period_key);

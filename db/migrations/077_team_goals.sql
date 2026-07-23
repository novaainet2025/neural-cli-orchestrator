-- 077: 목표설정(team_goals) + 성과보고 구분(work_reports.report_kind)
-- 회사/팀이 일/주/월 목표를 설정하고 진척(current vs target)을 기록·비교한다.
-- 성과보고는 기존 work_reports 파이프라인을 report_kind로 재사용한다('work'|'performance'|'goal').

ALTER TABLE work_reports ADD COLUMN report_kind TEXT NOT NULL DEFAULT 'work';

CREATE TABLE IF NOT EXISTS team_goals (
  id            TEXT PRIMARY KEY,
  subject_kind  TEXT NOT NULL,                      -- 'organization' | 'team'
  subject_id    TEXT NOT NULL,
  period        TEXT NOT NULL,                       -- 'daily' | 'weekly' | 'monthly'
  period_key    TEXT NOT NULL,                       -- '2026-07-24' | '2026-W30' | '2026-07'
  title         TEXT NOT NULL,
  metric        TEXT,                                -- 측정 대상(자유서술 또는 알려진 지표 키)
  target_value  REAL,
  current_value REAL NOT NULL DEFAULT 0,
  unit          TEXT,
  status        TEXT NOT NULL DEFAULT 'active',      -- 'active' | 'met' | 'missed' | 'archived'
  note          TEXT,                                -- 반성/개선 메모
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_team_goals_subject ON team_goals(subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS idx_team_goals_period  ON team_goals(period, period_key);

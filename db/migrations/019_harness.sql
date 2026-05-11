-- NCO Harness Engine — 실행 리포트 저장소
CREATE TABLE IF NOT EXISTS harness_reports (
  id                TEXT    PRIMARY KEY,
  requirement       TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'completed',  -- completed | partial | failed
  total_iterations  INTEGER NOT NULL DEFAULT 1,
  final_avg_score   REAL    NOT NULL DEFAULT 0,
  report_json       TEXT    NOT NULL DEFAULT '{}',
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_harness_reports_created ON harness_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_harness_reports_status ON harness_reports (status);

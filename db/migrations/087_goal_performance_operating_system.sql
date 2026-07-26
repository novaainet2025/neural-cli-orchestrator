-- 087: NCO 목표·성과·최종지휘 운영체계
-- 기존 team_goals/performance_reports를 단일 진실원천으로 유지한다.
-- 과거 수동 성과보고의 중복은 보존하고, 자동 생성분만 유일하게 보장한다.

ALTER TABLE performance_reports
ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE performance_reports
ADD COLUMN updated_at TEXT;

UPDATE performance_reports
SET updated_at = created_at
WHERE updated_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_goals_performance_governance
  ON team_goals(subject_kind, subject_id, period, period_key, source)
  WHERE source = 'performance-governance';

CREATE UNIQUE INDEX IF NOT EXISTS idx_performance_reports_governance
  ON performance_reports(subject_kind, subject_id, period, period_key, source)
  WHERE source = 'performance-governance';

CREATE TABLE IF NOT EXISTS commander_operation_audits (
  id TEXT PRIMARY KEY,
  audit_time TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL DEFAULT 'scheduled',
  status TEXT NOT NULL CHECK(status IN ('pass', 'attention', 'fail')),
  active_organizations INTEGER NOT NULL DEFAULT 0,
  active_teams INTEGER NOT NULL DEFAULT 0,
  goals_expected INTEGER NOT NULL DEFAULT 0,
  goals_present INTEGER NOT NULL DEFAULT 0,
  reports_expected INTEGER NOT NULL DEFAULT 0,
  reports_present INTEGER NOT NULL DEFAULT 0,
  failed_tasks INTEGER NOT NULL DEFAULT 0,
  stalled_tasks INTEGER NOT NULL DEFAULT 0,
  missed_work_reports INTEGER NOT NULL DEFAULT 0,
  schedules_expected INTEGER NOT NULL DEFAULT 0,
  schedules_healthy INTEGER NOT NULL DEFAULT 0,
  checks_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_commander_operation_audits_time
  ON commander_operation_audits(audit_time DESC);

INSERT OR IGNORE INTO cron_jobs (
  id, description, schedule, task_type, payload, timezone,
  max_retries, backoff_ms, enabled
) VALUES
  (
    'pg-hourly-progress-refresh',
    'Performance governance: refresh all active organization and team goals/reports',
    '0 * * * *', 'internal', '{"action":"pg-hourly-progress-refresh"}',
    'Asia/Seoul', 1, 60000, 1
  ),
  (
    'pg-daily-rollup',
    'Performance governance: finalize previous KST day and open the new day',
    '10 0 * * *', 'internal', '{"action":"pg-daily-rollup"}',
    'Asia/Seoul', 1, 60000, 1
  ),
  (
    'pg-weekly-rollup',
    'Performance governance: finalize previous ISO week and open the new week',
    '15 0 * * 1', 'internal', '{"action":"pg-weekly-rollup"}',
    'Asia/Seoul', 1, 60000, 1
  ),
  (
    'pg-monthly-rollup',
    'Performance governance: finalize previous KST month and open the new month',
    '20 0 1 * *', 'internal', '{"action":"pg-monthly-rollup"}',
    'Asia/Seoul', 1, 60000, 1
  ),
  (
    'pg-hourly-commander-audit',
    'Supreme commander: audit coverage, failures, stalls, reports and automation timing',
    '5 * * * *', 'internal', '{"action":"pg-hourly-commander-audit"}',
    'Asia/Seoul', 1, 60000, 1
  );

UPDATE cron_jobs
SET
  description = CASE id
    WHEN 'pg-hourly-progress-refresh' THEN 'Performance governance: refresh all active organization and team goals/reports'
    WHEN 'pg-daily-rollup' THEN 'Performance governance: finalize previous KST day and open the new day'
    WHEN 'pg-weekly-rollup' THEN 'Performance governance: finalize previous ISO week and open the new week'
    WHEN 'pg-monthly-rollup' THEN 'Performance governance: finalize previous KST month and open the new month'
    ELSE 'Supreme commander: audit coverage, failures, stalls, reports and automation timing'
  END,
  schedule = CASE id
    WHEN 'pg-hourly-progress-refresh' THEN '0 * * * *'
    WHEN 'pg-daily-rollup' THEN '10 0 * * *'
    WHEN 'pg-weekly-rollup' THEN '15 0 * * 1'
    WHEN 'pg-monthly-rollup' THEN '20 0 1 * *'
    ELSE '5 * * * *'
  END,
  task_type = 'internal',
  payload = '{"action":"' || CASE id
    WHEN 'pg-hourly-progress-refresh' THEN 'pg-hourly-progress-refresh'
    WHEN 'pg-daily-rollup' THEN 'pg-daily-rollup'
    WHEN 'pg-weekly-rollup' THEN 'pg-weekly-rollup'
    WHEN 'pg-monthly-rollup' THEN 'pg-monthly-rollup'
    ELSE 'pg-hourly-commander-audit'
  END || '"}',
  timezone = 'Asia/Seoul',
  max_retries = 1,
  backoff_ms = 60000,
  enabled = 1,
  updated_at = datetime('now')
WHERE id IN (
  'pg-hourly-progress-refresh',
  'pg-daily-rollup',
  'pg-weekly-rollup',
  'pg-monthly-rollup',
  'pg-hourly-commander-audit'
);

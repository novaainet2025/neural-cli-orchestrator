-- 084: 당일 목표 자동 커버리지 + 인사/자가개선 시간별 역할 감사.

ALTER TABLE team_goals
ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_goals_hr_daily_coverage
  ON team_goals(subject_kind, subject_id, period, period_key, source)
  WHERE source = 'hr-daily-coverage';

CREATE TABLE IF NOT EXISTS hourly_role_audits (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('hr', 'self-improvement')),
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pass', 'attention', 'fail')),
  checks_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'scheduled'
    CHECK(source IN ('scheduled', 'startup', 'manual')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hourly_role_audits_subject_created
  ON hourly_role_audits(subject_kind, created_at DESC);

-- 그래프에는 실제 실행 예약만 표시한다.
UPDATE teams
SET schedule = '*/10 * * * *', updated_at = datetime('now')
WHERE id = 'team_hr-director';

UPDATE organizations
SET schedule = '20 * * * *', updated_at = datetime('now')
WHERE id = 'org_nco-self';

INSERT OR IGNORE INTO cron_jobs (
  id, description, schedule, task_type, payload, timezone,
  max_retries, backoff_ms, enabled
) VALUES (
  'hr-hourly-role-audit',
  'Hourly HR role, daily goal coverage, and self-improvement evidence audit',
  '35 * * * *',
  'internal',
  '{"action":"hr-hourly-role-audit"}',
  'Asia/Seoul',
  1,
  60000,
  1
);

UPDATE cron_jobs
SET
  description = 'Hourly HR role, daily goal coverage, and self-improvement evidence audit',
  schedule = '35 * * * *',
  task_type = 'internal',
  payload = '{"action":"hr-hourly-role-audit"}',
  timezone = 'Asia/Seoul',
  max_retries = 1,
  backoff_ms = 60000,
  enabled = 1,
  updated_at = datetime('now')
WHERE id = 'hr-hourly-role-audit';

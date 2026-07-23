-- 083: HR Director를 팀 생애주기 관리자로 격상하고, 개선/퇴출 감사 이력을 저장한다.

CREATE TABLE IF NOT EXISTS team_lifecycle_profiles (
  team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'improving', 'probation', 'retired')),
  improvement_count INTEGER NOT NULL DEFAULT 0 CHECK(improvement_count >= 0),
  successful_improvement_count INTEGER NOT NULL DEFAULT 0
    CHECK(successful_improvement_count >= 0),
  failed_improvement_count INTEGER NOT NULL DEFAULT 0
    CHECK(failed_improvement_count >= 0),
  unresolved_improvement_count INTEGER NOT NULL DEFAULT 0
    CHECK(unresolved_improvement_count >= 0),
  consecutive_low_checks INTEGER NOT NULL DEFAULT 0
    CHECK(consecutive_low_checks >= 0),
  last_score REAL,
  last_sample_size INTEGER NOT NULL DEFAULT 0 CHECK(last_sample_size >= 0),
  first_low_at TEXT,
  last_checked_at TEXT,
  last_improvement_at TEXT,
  active_run_id TEXT,
  retired_at TEXT,
  retirement_reason TEXT,
  protected INTEGER NOT NULL DEFAULT 0 CHECK(protected IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS team_lifecycle_events (
  id TEXT PRIMARY KEY,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  team_slug TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'score_checked',
    'score_recovered',
    'hr_directive',
    'improvement_started',
    'improvement_completed',
    'improvement_failed',
    'improvement_trigger_failed',
    'probation_started',
    'retired',
    'restored'
  )),
  score REAL,
  improvement_count INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  company_run_id TEXT,
  source TEXT NOT NULL DEFAULT 'scheduled'
    CHECK(source IN ('scheduled', 'event', 'manual', 'system')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_team_lifecycle_status
  ON team_lifecycle_profiles(status, last_checked_at);
CREATE INDEX IF NOT EXISTS idx_team_lifecycle_events_team_created
  ON team_lifecycle_events(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_lifecycle_events_type_created
  ON team_lifecycle_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS hr_retirement_watchlist (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('organization', 'team')),
  subject_id TEXT NOT NULL,
  subject_slug TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'watchlisted'
    CHECK(status IN ('watchlisted', 'approved', 'dismissed', 'retired')),
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  reviewed_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_retirement_watchlist_open
  ON hr_retirement_watchlist(subject_kind, subject_id)
  WHERE status = 'watchlisted';
CREATE INDEX IF NOT EXISTS idx_hr_retirement_watchlist_status
  ON hr_retirement_watchlist(status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS hr_weekly_org_actions (
  id TEXT PRIMARY KEY,
  week_key TEXT NOT NULL UNIQUE,
  action_type TEXT NOT NULL CHECK(action_type IN ('team_created', 'organization_created')),
  subject_id TEXT NOT NULL,
  subject_slug TEXT NOT NULL,
  based_on_goal_id TEXT,
  performance_reports_reviewed INTEGER NOT NULL DEFAULT 0,
  work_reports_reviewed INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 인사팀은 정책·감사·생애주기 지시를 담당한다. 실제 개선 작업은 nco-self가 수행한다.
UPDATE teams
SET
  name = 'Team Lifecycle HR Director',
  lead = 'hermes',
  charter = 'NOVA AX 팀 생애주기 인사팀. 모든 활성 팀을 10분마다 평가하고, 점수 90점 이하 팀에 개선 지시를 발행해 nco-self개선 회사를 실행한다. 개선 횟수와 결과를 감사 DB에 기록하며, 반복 미개선 팀은 소프트 퇴출(is_active=0)한다. 회사 실패의 지배적 병목으로 객관적으로 확인된 비핵심 팀은 즉시 소프트 퇴출한다. 매주 성과보고와 목표를 검토해 근거 기반 인큐베이션 팀 또는 회사를 하나 생성하고, 30일 사용량이 기준 미달인 팀·회사는 퇴출 후보 목록에 등록한다. 팀 생성·격상·복구·퇴출은 근거와 이력을 남기고 실행한다.',
  is_always_on = 1,
  is_active = 1,
  updated_at = datetime('now')
WHERE id = 'team_hr-director';

DELETE FROM team_members WHERE team_id = 'team_hr-director';
INSERT OR IGNORE INTO team_members (id, team_id, member_type, member_ref)
SELECT 'tm_hr-director-hermes', id, 'provider', 'hermes'
FROM teams
WHERE id = 'team_hr-director';

INSERT OR IGNORE INTO team_lifecycle_profiles (team_id, protected)
SELECT t.id, 1
FROM teams t
LEFT JOIN organizations o ON o.id = t.organization_id
WHERE t.id = 'team_hr-director' OR o.slug = 'nco-self';

-- 기존 6시간 진단을 10분 생애주기 점검으로 격상한다.
INSERT OR IGNORE INTO cron_jobs (
  id, description, schedule, task_type, payload, timezone,
  max_retries, backoff_ms, enabled
) VALUES (
  'team-score-diagnostics',
  'HR team lifecycle review: score, improve, probation, and soft retirement',
  '*/10 * * * *',
  'internal',
  '{"action":"team-lifecycle-review"}',
  'Asia/Seoul',
  1,
  60000,
  1
);

UPDATE cron_jobs
SET
  description = 'HR team lifecycle review: score, improve, probation, and soft retirement',
  schedule = '*/10 * * * *',
  task_type = 'internal',
  payload = '{"action":"team-lifecycle-review"}',
  timezone = 'Asia/Seoul',
  max_retries = 1,
  backoff_ms = 60000,
  enabled = 1,
  updated_at = datetime('now')
WHERE id = 'team-score-diagnostics';

INSERT OR IGNORE INTO cron_jobs (
  id, description, schedule, task_type, payload, timezone,
  max_retries, backoff_ms, enabled
) VALUES (
  'hr-weekly-workforce-planning',
  'HR weekly goal/performance review, incubation creation, and retirement watchlist refresh',
  '0 9 * * 1',
  'internal',
  '{"action":"hr-weekly-workforce-planning"}',
  'Asia/Seoul',
  1,
  60000,
  1
);

UPDATE cron_jobs
SET
  description = 'HR weekly goal/performance review, incubation creation, and retirement watchlist refresh',
  schedule = '0 9 * * 1',
  task_type = 'internal',
  payload = '{"action":"hr-weekly-workforce-planning"}',
  timezone = 'Asia/Seoul',
  max_retries = 1,
  backoff_ms = 60000,
  enabled = 1,
  updated_at = datetime('now')
WHERE id = 'hr-weekly-workforce-planning';

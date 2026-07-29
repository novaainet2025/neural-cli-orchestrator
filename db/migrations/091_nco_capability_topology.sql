-- 091_nco_capability_topology.sql

CREATE TABLE IF NOT EXISTS required_organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  graph_type TEXT NOT NULL,
  manager TEXT,
  parent_id TEXT,
  is_always_on INTEGER NOT NULL,
  is_active INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS required_capabilities (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL,
  color TEXT NOT NULL,
  lead TEXT NOT NULL,
  charter TEXT NOT NULL,
  is_always_on INTEGER NOT NULL,
  protected INTEGER NOT NULL,
  is_active INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_design_audits (
  id TEXT PRIMARY KEY,
  audit_time TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  active_organizations INTEGER NOT NULL DEFAULT 0,
  active_teams INTEGER NOT NULL DEFAULT 0,
  org_expected INTEGER NOT NULL DEFAULT 0,
  org_present INTEGER NOT NULL DEFAULT 0,
  org_repaired INTEGER NOT NULL DEFAULT 0,
  cap_expected INTEGER NOT NULL DEFAULT 0,
  cap_present INTEGER NOT NULL DEFAULT 0,
  cap_repaired INTEGER NOT NULL DEFAULT 0,
  members_before_zero INTEGER NOT NULL DEFAULT 0,
  members_before_one INTEGER NOT NULL DEFAULT 0,
  members_before_two INTEGER NOT NULL DEFAULT 0,
  members_after_coverage INTEGER NOT NULL DEFAULT 0,
  collaboration_coverage_before REAL NOT NULL DEFAULT 0,
  collaboration_coverage_after REAL NOT NULL DEFAULT 0,
  missing_lead_before INTEGER NOT NULL DEFAULT 0,
  missing_lead_after INTEGER NOT NULL DEFAULT 0,
  missing_charter_before INTEGER NOT NULL DEFAULT 0,
  missing_charter_after INTEGER NOT NULL DEFAULT 0,
  excess_json TEXT NOT NULL DEFAULT '[]',
  actions_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS team_consolidations (
  id TEXT PRIMARY KEY,
  old_team_id TEXT UNIQUE NOT NULL,
  new_team_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  consolidated_at TEXT NOT NULL
);

INSERT INTO required_organizations (id, name, slug, graph_type, manager, parent_id, is_always_on, is_active)
VALUES
('org_nco-command', 'NCO Executive Command and Orchestration Company', 'nco-command', 'nova-ax', 'claude-code', 'org_nova-ax', 1, 1),
('org_nco-evolution', 'NCO Learning and Evolution Company', 'nco-evolution', 'nova-ax', 'opencode', 'org_nova-ax', 1, 1),
('org_nco-engineering', 'NCO Expert Engineering Company', 'nco-engineering', 'nova-ax', 'codex', 'org_nova-ax', 1, 1),
('org_nco-assurance', 'NCO Independent Assurance and Safety Company', 'nco-assurance', 'nova-ax', 'cursor-agent', 'org_nova-ax', 1, 1),
('org_nco-government', 'NCO AI Governance and Public Administration Company', 'nco-government', 'nova-ax', 'hermes', 'org_nova-ax', 1, 1)
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name,
  slug=excluded.slug,
  graph_type=excluded.graph_type,
  manager=excluded.manager,
  parent_id=excluded.parent_id,
  is_always_on=excluded.is_always_on,
  is_active=excluded.is_active;

INSERT INTO required_capabilities (id, organization_id, name, slug, description, color, lead, charter, is_always_on, protected, is_active)
SELECT id, organization_id, name, slug, description, color, lead, charter, is_always_on, 1, 1
FROM teams
WHERE id IN (
  'team_gov-command-strategic', 'team_gov-command-intake', 'team_gov-command-routing',
  'team_gov-command-collaboration', 'team_gov-command-incident',
  'team_gov-evolution-learning', 'team_gov-evolution-memory', 'team_gov-evolution-evaluation',
  'team_gov-evolution-improvement', 'team_gov-evolution-skills',
  'team_gov-engineering-experts', 'team_gov-engineering-architecture', 'team_gov-engineering-build',
  'team_gov-engineering-release', 'team_gov-engineering-reliability',
  'team_gov-assurance-verification', 'team_gov-assurance-safety', 'team_gov-assurance-redteam',
  'team_gov-assurance-audit', 'team_gov-assurance-resilience',
  'team_gov-government-constitution', 'team_gov-government-rights', 'team_gov-government-hr',
  'team_gov-government-treasury', 'team_gov-government-transparency'
)
ON CONFLICT(id) DO UPDATE SET
  organization_id=excluded.organization_id,
  name=excluded.name,
  slug=excluded.slug,
  description=excluded.description,
  color=excluded.color,
  lead=excluded.lead,
  charter=excluded.charter,
  is_always_on=excluded.is_always_on,
  protected=excluded.protected,
  is_active=excluded.is_active;

UPDATE organizations SET is_active = 1 WHERE id IN (SELECT id FROM required_organizations);
UPDATE teams SET is_active = 1 WHERE id IN (SELECT id FROM required_capabilities);

INSERT OR IGNORE INTO team_lifecycle_profiles (
  team_id, status, protected,
  improvement_count, successful_improvement_count, failed_improvement_count,
  unresolved_improvement_count, consecutive_low_checks,
  last_score, last_sample_size,
  first_low_at, last_checked_at, last_improvement_at, active_run_id,
  retired_at, retirement_reason,
  updated_at
)
SELECT
  id, 'active', 1,
  0, 0, 0,
  0, 0,
  NULL, 0,
  NULL, NULL, NULL, NULL,
  NULL, NULL,
  datetime('now')
FROM required_capabilities;

UPDATE team_lifecycle_profiles
SET
  status = 'active',
  protected = 1,
  improvement_count = 0,
  successful_improvement_count = 0,
  failed_improvement_count = 0,
  unresolved_improvement_count = 0,
  consecutive_low_checks = 0,
  last_score = NULL,
  last_sample_size = 0,
  first_low_at = NULL,
  last_checked_at = NULL,
  last_improvement_at = NULL,
  active_run_id = NULL,
  retired_at = NULL,
  retirement_reason = NULL,
  updated_at = datetime('now')
WHERE team_id IN (SELECT id FROM required_capabilities);

INSERT INTO organizations (id, name, slug, graph_type, manager, is_always_on, is_active)
VALUES ('org_knowledge-diet', 'Knowledge Diet', 'knowledge-diet', 'nova-ax', 'ollama', 1, 1)
ON CONFLICT(id) DO NOTHING;

INSERT INTO teams (
  id, organization_id, name, slug, description, color, lead, charter,
  is_always_on, is_active
) VALUES (
  'team_kd-quality-hygiene',
  'org_knowledge-diet',
  'Quality and Hygiene',
  'kd-quality-hygiene',
  'Maintain data quality, deduplication, and context hygiene for AI diet.',
  '#F59E0B',
  'ollama',
  '지식 다이어트의 품질과 위생을 관리한다. 중복되거나 불필요한 맥락을 제거하고 고품질 지식만 선별하여 AI가 섭취하도록 보장한다.',
  0,
  1
) ON CONFLICT(id) DO UPDATE SET
  organization_id=excluded.organization_id,
  name=excluded.name,
  slug=excluded.slug,
  description=excluded.description,
  color=excluded.color,
  lead=excluded.lead,
  charter=excluded.charter,
  is_always_on=excluded.is_always_on,
  is_active=excluded.is_active,
  updated_at=datetime('now');

INSERT INTO team_members (id, team_id, member_type, member_ref)
VALUES
  ('member_kd_quality_hygiene_ollama', 'team_kd-quality-hygiene', 'provider', 'ollama'),
  ('member_kd_quality_hygiene_cursor', 'team_kd-quality-hygiene', 'provider', 'cursor-agent'),
  ('member_kd_quality_hygiene_codex', 'team_kd-quality-hygiene', 'provider', 'codex')
ON CONFLICT(team_id, member_type, member_ref) DO NOTHING;

UPDATE teams
SET is_active = 0, updated_at = datetime('now')
WHERE id IN (
  'team_kd-harness',
  'team_kd-memory',
  'team_kd-obsidian',
  'team_kd-prompt',
  'team_kd-provider'
);

INSERT INTO team_consolidations (id, old_team_id, new_team_id, reason, evidence_json, consolidated_at)
VALUES
  ('tc_' || hex(randomblob(8)), 'team_kd-harness', 'team_kd-quality-hygiene', 'Consolidated to quality-hygiene', '{"action": "migration_091"}', datetime('now')),
  ('tc_' || hex(randomblob(8)), 'team_kd-memory', 'team_kd-quality-hygiene', 'Consolidated to quality-hygiene', '{"action": "migration_091"}', datetime('now')),
  ('tc_' || hex(randomblob(8)), 'team_kd-obsidian', 'team_kd-quality-hygiene', 'Consolidated to quality-hygiene', '{"action": "migration_091"}', datetime('now')),
  ('tc_' || hex(randomblob(8)), 'team_kd-prompt', 'team_kd-quality-hygiene', 'Consolidated to quality-hygiene', '{"action": "migration_091"}', datetime('now')),
  ('tc_' || hex(randomblob(8)), 'team_kd-provider', 'team_kd-quality-hygiene', 'Consolidated to quality-hygiene', '{"action": "migration_091"}', datetime('now'))
ON CONFLICT(old_team_id) DO UPDATE SET
  new_team_id=excluded.new_team_id,
  reason=excluded.reason,
  evidence_json=excluded.evidence_json,
  consolidated_at=excluded.consolidated_at;

INSERT INTO cron_jobs (id, description, schedule, task_type, payload, timezone, enabled, created_at, updated_at)
VALUES (
  'org-design-hourly-audit',
  'Hourly org design audit',
  '15 * * * *',
  'internal',
  '{"action": "org-design-hourly-audit"}',
  'Asia/Seoul',
  1,
  datetime('now'),
  datetime('now')
)
ON CONFLICT(id) DO UPDATE SET
  description=excluded.description,
  schedule=excluded.schedule,
  task_type=excluded.task_type,
  payload=excluded.payload,
  timezone=excluded.timezone,
  enabled=excluded.enabled,
  updated_at=datetime('now');

const fs = require('fs');

const sql086 = fs.readFileSync('/Users/nova-ai/project/nco/db/migrations/086_nco_ai_government_foundation.sql', 'utf8');

let teams = [];
// find lines like: 'team_gov-command-strategic',
const lines = sql086.split('\n');
for (const line of lines) {
  const match = line.match(/^\s*'team_gov-([a-zA-Z0-9\-]+)',?\s*$/);
  if (match) {
    teams.push('team_gov-' + match[1]);
  }
}

// deduplicate
teams = [...new Set(teams)];

const orgs = [
  'org_nco-command',
  'org_nco-evolution',
  'org_nco-engineering',
  'org_nco-assurance',
  'org_nco-government'
];

let out = `
CREATE TABLE IF NOT EXISTS required_organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS required_capabilities (
  id TEXT PRIMARY KEY,
  role_name TEXT NOT NULL,
  description TEXT,
  team_id TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS organization_design_audits (
  id TEXT PRIMARY KEY,
  audit_time DATETIME NOT NULL,
  source TEXT NOT NULL,
  active_organizations INTEGER NOT NULL,
  active_teams INTEGER NOT NULL,
  capabilities_expected INTEGER NOT NULL,
  capabilities_present INTEGER NOT NULL,
  capabilities_repaired INTEGER NOT NULL,
  members_before_zero INTEGER NOT NULL,
  members_before_one INTEGER NOT NULL,
  members_after_coverage INTEGER NOT NULL,
  collaboration_coverage_before REAL NOT NULL,
  collaboration_coverage_after REAL NOT NULL,
  excess_candidates_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS team_consolidations (
  id TEXT PRIMARY KEY,
  old_team_id TEXT NOT NULL,
  new_team_id TEXT NOT NULL,
  reason TEXT,
  consolidated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO required_organizations (id, name, slug) VALUES
${orgs.map(o => `('${o}', '${o}', '${o.replace('org_', '')}')`).join(',\n')};

INSERT OR IGNORE INTO required_capabilities (id, role_name, team_id, description) VALUES
${teams.map(t => `('rc_${t.replace('team_', '').replace(/-/g, '_')}', '${t.replace('team_', '')}', '${t}', 'Required capability for ${t}')`).join(',\n')};

-- Protect all 25 teams
INSERT INTO team_lifecycle_profiles (team_id, protected, status, updated_at)
SELECT team_id, 1, 'active', datetime('now') FROM required_capabilities WHERE is_active=1
ON CONFLICT(team_id) DO UPDATE SET protected=1, status='active', retired_at=NULL, retirement_reason=NULL, updated_at=datetime('now');

-- Reset mistakenly deactivated 5 teams
UPDATE teams SET is_active=1, updated_at=datetime('now') WHERE id IN (
  'team_gov-engineering-reliability',
  'team_gov-assurance-resilience',
  'team_gov-evolution-evaluation',
  'team_gov-evolution-improvement',
  'team_gov-government-rights'
);

-- KD soft consolidation
INSERT INTO organizations (id, name, slug, graph_type, is_always_on, is_active)
VALUES ('org_knowledge-diet', 'Knowledge Diet', 'knowledge-diet', 'nova-ax', 1, 1)
ON CONFLICT(id) DO UPDATE SET is_active=1;

INSERT INTO teams (id, organization_id, name, slug, lead, is_always_on, is_active)
VALUES ('team_kd-quality-hygiene', 'org_knowledge-diet', 'KD Quality Hygiene', 'kd-quality-hygiene', 'ollama', 0, 1)
ON CONFLICT(id) DO UPDATE SET is_active=1, lead='ollama';

INSERT OR IGNORE INTO team_members (id, team_id, member_type, member_ref) VALUES
('tm_kd_qh_ollama', 'team_kd-quality-hygiene', 'provider', 'ollama'),
('tm_kd_qh_cursor', 'team_kd-quality-hygiene', 'provider', 'cursor-agent'),
('tm_kd_qh_codex', 'team_kd-quality-hygiene', 'provider', 'codex');

INSERT INTO team_consolidations (id, old_team_id, new_team_id, reason)
SELECT 'tc_' || id, id, 'team_kd-quality-hygiene', 'KD restructuring'
FROM teams 
WHERE id LIKE 'team_kd-%' AND id != 'team_kd-quality-hygiene' AND is_active=1
ON CONFLICT(id) DO NOTHING;

UPDATE teams 
SET is_active=0, updated_at=datetime('now')
WHERE id LIKE 'team_kd-%' AND id != 'team_kd-quality-hygiene';

INSERT INTO cron_jobs (
  id, description, schedule, task_type, payload, timezone, max_retries, backoff_ms, enabled
) VALUES (
  'org-design-hourly-audit',
  'Organization design audit: required capability continuity, member coverage, excess reporting',
  '15 * * * *',
  'internal',
  '{"action":"org-design-hourly-audit"}',
  'Asia/Seoul',
  1,
  60000,
  1
) ON CONFLICT(id) DO UPDATE SET
  description=excluded.description,
  schedule=excluded.schedule,
  task_type=excluded.task_type,
  payload=excluded.payload,
  timezone=excluded.timezone,
  max_retries=excluded.max_retries,
  backoff_ms=excluded.backoff_ms,
  enabled=excluded.enabled;
`;

fs.writeFileSync('/Users/nova-ai/project/nco/db/migrations/091_nco_capability_topology.sql', out.trim() + '\n');
console.log('Done, found ' + teams.length + ' teams');

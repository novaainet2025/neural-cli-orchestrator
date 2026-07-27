import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

const dbPath = process.argv[2] || 'db/nco.db';
const db = new Database(dbPath, { readonly: true });

const q = (sql, params = []) => db.prepare(sql).all(...params);
const q1 = (sql, params = []) => db.prepare(sql).get(...params);

const result = { db: dbPath };

// 1. Active orgs
result.active_orgs = q1(`SELECT COUNT(*) AS count FROM organizations WHERE is_active=1`).count;

// 2. Active teams
result.active_teams = q1(`SELECT COUNT(*) AS count FROM teams WHERE is_active=1`).count;

// 3. Teams with member count < 3 (enabled providers only)
result.teams_under_3_members = q(`
  SELECT t.id, t.name, COUNT(tm.id) AS member_count
  FROM teams t
  LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.removed_at IS NULL
  LEFT JOIN agents a ON tm.member_type = 'provider' AND tm.member_ref = a.id AND a.enabled = 1
  WHERE t.is_active = 1
  GROUP BY t.id
  HAVING COUNT(CASE WHEN tm.member_type = 'provider' AND tm.removed_at IS NULL AND a.enabled = 1 THEN 1 END) < 3
  ORDER BY t.id
`);
result.teams_under_3_members_count = result.teams_under_3_members.length;

// Alternative simpler query for count only
result.teams_under_3_members_count_v2 = q1(`
  SELECT COUNT(*) AS count FROM (
    SELECT t.id
    FROM teams t
    WHERE t.is_active = 1
    AND (
      SELECT COUNT(*)
      FROM team_members tm
      JOIN agents a ON tm.member_ref = a.id AND tm.member_type = 'provider'
      WHERE tm.team_id = t.id AND tm.removed_at IS NULL AND a.enabled = 1
    ) < 3
  )
`).count;

// 4. Missing lead
result.missing_lead = q1(`SELECT COUNT(*) AS count FROM teams WHERE is_active=1 AND (lead IS NULL OR lead='')`).count;

// 5. Missing charter
result.missing_charter = q1(`SELECT COUNT(*) AS count FROM teams WHERE is_active=1 AND (charter IS NULL OR charter='')`).count;

// 6. Latest organization_design_audits (last 10)
result.organization_design_audits_last_10 = q(`
  SELECT id, audit_time, source, status,
    active_organizations, active_teams,
    org_expected, org_present, org_repaired,
    cap_expected, cap_present, cap_repaired,
    members_before_zero, members_before_one, members_before_two,
    members_after_coverage,
    collaboration_coverage_before, collaboration_coverage_after,
    missing_lead_before, missing_lead_after,
    missing_charter_before, missing_charter_after,
    actions_json, evidence_json
  FROM organization_design_audits
  ORDER BY audit_time DESC
  LIMIT 10
`);

// Specific audit IDs
const specificIds = [
  'org-design_GgSswOAH1UEgVs5b',
  'org-design_MHuoScsNE0bjjQ1o',
  'org-design_lrCgBDTA1u_9lelL',
  'org-design_LGRmlg9l_13jjgvk'
];
result.organization_design_audits_specific = q(`
  SELECT id, audit_time, source, status,
    active_organizations, active_teams,
    org_expected, org_present, org_repaired,
    cap_expected, cap_present, cap_repaired,
    members_before_zero, members_before_one, members_before_two,
    members_after_coverage,
    collaboration_coverage_before, collaboration_coverage_after,
    missing_lead_before, missing_lead_after,
    missing_charter_before, missing_charter_after,
    actions_json, evidence_json
  FROM organization_design_audits
  WHERE id IN (${specificIds.map(() => '?').join(',')})
`, specificIds);

// 7. team_consolidations for kd teams
result.team_consolidations_kd = q(`
  SELECT * FROM team_consolidations
  WHERE old_team_id LIKE 'team_kd-%' OR new_team_id LIKE 'team_kd-%'
  ORDER BY consolidated_at DESC
`);

// 8. required counts
result.required_organizations_count = q1(`SELECT COUNT(*) AS count FROM required_organizations`).count;
result.required_capabilities_count = q1(`SELECT COUNT(*) AS count FROM required_capabilities`).count;

// 9. KD old teams status
const kdTeams = [
  'team_kd-harness', 'team_kd-memory', 'team_kd-obsidian',
  'team_kd-prompt', 'team_kd-provider', 'team_kd-quality-hygiene'
];
result.kd_teams_status = q(`
  SELECT id, is_active, lead, charter FROM teams
  WHERE id IN (${kdTeams.map(() => '?').join(',')})
  ORDER BY id
`, kdTeams);

// 10. Cron jobs
try {
  result.cron_org_design_hourly_audit = q1(`
    SELECT id, description, schedule, enabled, task_type, payload, timezone, updated_at
    FROM cron_jobs WHERE id = 'org-design-hourly-audit'
  `);
} catch (e) {
  result.cron_org_design_hourly_audit = { error: e.message };
}

// 11. Failed tasks last 24h - check schema first
result.tasks_columns = q(`PRAGMA table_info(tasks)`);
const taskTimeCols = result.tasks_columns.map(c => c.name).filter(n => n.includes('at') || n.includes('time'));
result.tasks_time_columns = taskTimeCols;

for (const col of ['updated_at', 'created_at', 'finished_at', 'completed_at']) {
  const hasCol = result.tasks_columns.some(c => c.name === col);
  if (hasCol) {
    result[`failed_tasks_24h_by_${col}`] = q1(`
      SELECT COUNT(*) AS count FROM tasks
      WHERE status IN ('failed','timeout','timed_out')
      AND ${col} > datetime('now','-24 hours')
    `).count;
  }
}

// 12. Commander operation audits
try {
  const tables = q(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%commander%' OR name LIKE '%operation%audit%'`);
  result.commander_related_tables = tables;
  if (tables.some(t => t.name === 'commander_operation_audits')) {
    result.commander_operation_audits_recent = q(`
      SELECT * FROM commander_operation_audits ORDER BY created_at DESC LIMIT 10
    `);
  }
} catch (e) {
  result.commander_operation_audits = { error: e.message };
}

// 15. Collaboration coverage
const coverage = q1(`
  SELECT
    COUNT(*) AS total_active_teams,
    SUM(CASE WHEN member_count >= 3 THEN 1 ELSE 0 END) AS teams_with_3plus,
    ROUND(CAST(SUM(CASE WHEN member_count >= 3 THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0), 4) AS coverage_fraction
  FROM (
    SELECT t.id,
      (SELECT COUNT(*)
       FROM team_members tm
       JOIN agents a ON tm.member_ref = a.id AND tm.member_type = 'provider'
       WHERE tm.team_id = t.id AND tm.removed_at IS NULL AND a.enabled = 1
      ) AS member_count
    FROM teams t
    WHERE t.is_active = 1
  )
`);
result.collaboration_coverage = coverage;

console.log(JSON.stringify(result, null, 2));
db.close();

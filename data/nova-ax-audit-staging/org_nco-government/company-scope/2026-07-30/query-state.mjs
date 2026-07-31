#!/usr/bin/env node
import Database from "../../../../../node_modules/better-sqlite3/lib/index.js";

const ax = new Database("/Users/nova-ai/project/nova-ax/db/nova-ax.db", { readonly: true });
const nco = new Database("/Users/nova-ai/project/nco/db/nco.db", { readonly: true });

const dirs = ax.prepare(`
  SELECT id, task_id AS taskId, team_id AS teamId, type, status, work_report_id AS workReportId
  FROM verification_directives
  WHERE company_id='org_nco-government'
  ORDER BY created_at DESC LIMIT 15
`).all();

const companyRuns = ax.prepare(`
  SELECT id AS runId, task_id AS taskId, status, passed_institutions AS passedInstitutions
  FROM verification_runs
  WHERE company_id='org_nco-government' AND team_id='company-scope'
  ORDER BY created_at DESC LIMIT 5
`).all();

const loops = ax.prepare(`
  SELECT id AS loopId, task_id AS taskId, team_id AS teamId, status, current_iteration AS currentIteration
  FROM verification_loops
  WHERE company_id='org_nco-government' AND team_id='company-scope'
`).all();

const pendingDir = ax.prepare(`
  SELECT id, task_id AS taskId, type, status
  FROM verification_directives
  WHERE company_id='org_nco-government' AND team_id='company-scope'
    AND status IN ('queued','dispatched')
  ORDER BY created_at DESC LIMIT 3
`).all();

const auditTask = nco.prepare(`
  SELECT t.id, t.status, t.assigned_to AS assignedTo,
         json_extract(t.metadata_json, '$.verificationDirectiveId') AS verificationDirectiveId,
         json_extract(t.metadata_json, '$.teamId') AS metadataTeamId
  FROM tasks t
  WHERE json_extract(t.metadata_json, '$.companyId') = 'org_nco-government'
    AND json_extract(t.metadata_json, '$.teamId') = 'company-scope'
  ORDER BY t.created_at DESC LIMIT 5
`).all();

const teams = nco.prepare(`
  SELECT id, name, slug, lead FROM teams
  WHERE organization_id='org_nco-government' AND is_active=1
  ORDER BY slug
`).all();

console.log(JSON.stringify({ dirs, companyRuns, loops, pendingDir, auditTask, teams }, null, 2));

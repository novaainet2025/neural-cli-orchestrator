import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { buildAuditApprovedCompletion, buildActiveWorkReportRetryExclusion, buildSpawnFailureExclusion, buildExternalZeroOutputExclusion, buildZeroOutputCompletedExclusion, buildProviderAuthExclusion, buildControlPlaneConnectionExclusion } from '../src/core/team-scorer.js';
const src = readFileSync('src/core/team-scorer.ts','utf8');
function grab(name: string): string {
  const m = src.match(new RegExp(`const ${name}[^=]*=\\s*\`([\\s\\S]*?)\`;`));
  return m ? m[1] : '';
}
const frags: Record<string,string> = {
  INFRA_EXCLUSION: grab('INFRA_EXCLUSION'),
  CONTROL_PLANE_PERFGOAL_EXCLUSION: grab('CONTROL_PLANE_PERFGOAL_EXCLUSION'),
  AUDIT_CONTROL_PLANE_EXCLUSION: grab('AUDIT_CONTROL_PLANE_EXCLUSION'),
  LEASE_NEVER_RAN_EXCLUSION: grab('LEASE_NEVER_RAN_EXCLUSION'),
  WORK_REPORT_DUP_DELIVERED_EXCLUSION: grab('WORK_REPORT_DUP_DELIVERED_EXCLUSION'),
  ACTIVE_WORK_REPORT_RETRY_EXCLUSION: buildActiveWorkReportRetryExclusion(),
  WORK_REPORT_FANOUT_ALL_FAILED_EXCLUSION: grab('WORK_REPORT_FANOUT_ALL_FAILED_EXCLUSION'),
  JOB_WAIT_DEAD_AGENT_EXCLUSION: grab('JOB_WAIT_DEAD_AGENT_EXCLUSION'),
  SPAWN_FAILURE_EXCLUSION: buildSpawnFailureExclusion(),
  PROVIDER_AUTH_EXCLUSION: buildProviderAuthExclusion(),
  CONTROL_PLANE_CONNECTION_EXCLUSION: buildControlPlaneConnectionExclusion(),
  EXTERNAL_ZERO_OUTPUT_EXCLUSION: buildExternalZeroOutputExclusion(),
  AUDIT_APPROVED_COMPLETION: buildAuditApprovedCompletion(),
  ZERO_OUTPUT_COMPLETED_EXCLUSION: buildZeroOutputCompletedExclusion(),
  FALSE_COMPLETION_EXCLUSION: grab('FALSE_COMPLETION_EXCLUSION'),
};
const joins = [grab('DELIVERED_WORK_REPORTS_JOIN'), grab('ACTIVE_WORK_REPORTS_JOIN'), grab('WORK_REPORT_FANOUT_ALL_FAILED_JOIN')].join('\n');
const db = new Database('db/nco.db', { readonly: true });
const tasks = db.prepare(`SELECT k.id, k.status, k.created_at FROM tasks k WHERE k.team_id='team_ax-decision-coordination-2026' AND k.status IN ('completed','failed','timed_out','lease_expired') AND julianday(k.created_at) >= julianday('now','-48 hours') ORDER BY k.created_at`).all() as any[];
for (const t of tasks) {
  const hits: string[] = [];
  for (const [name, frag] of Object.entries(frags)) {
    if (!frag.trim()) continue;
    const sql = `SELECT COUNT(*) c FROM tasks k ${joins} WHERE k.id=? ${frag}`;
    try {
      const r = db.prepare(sql).get(t.id) as any;
      if (r.c === 0) hits.push(name);
    } catch (e: any) { hits.push(name + ':ERR:' + e.message.slice(0,60)); }
  }
  console.log(`${t.id} ${t.status.padEnd(10)} ${t.created_at}  excludedBy=[${hits.join(', ')}]`);
}

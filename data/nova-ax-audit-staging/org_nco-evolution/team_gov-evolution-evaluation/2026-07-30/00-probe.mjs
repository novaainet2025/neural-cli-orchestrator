import Database from "better-sqlite3";
const NCO = new Database("/Users/nova-ai/project/nco/db/nco.db", { readonly: true });
const T = "team_gov-evolution-evaluation";
const statuses = NCO.prepare("SELECT status, COUNT(*) n FROM tasks WHERE team_id=? GROUP BY 1").all(T);
const total = statuses.reduce((s, r) => s + r.n, 0);
const reports = NCO.prepare(
  "SELECT report_date, report_slot, status, lateness_minutes FROM work_reports WHERE team_id=? ORDER BY report_date, report_slot"
).all(T);
const team = NCO.prepare("SELECT id, name, charter FROM teams WHERE id=?").get(T);
const recent7d = NCO.prepare(
  "SELECT COUNT(*) n FROM tasks WHERE team_id=? AND created_at >= datetime('now','-7 days')"
).get(T).n;
const completed7d = NCO.prepare(
  "SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='completed' AND created_at >= datetime('now','-7 days')"
).get(T).n;
const failed7d = NCO.prepare(
  "SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='failed' AND created_at >= datetime('now','-7 days')"
).get(T).n;
const inProgress7d = NCO.prepare(
  "SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status NOT IN ('completed','failed') AND created_at >= datetime('now','-7 days')"
).get(T).n;
console.log(JSON.stringify({ team, statuses, total, reports, recent7d, completed7d, failed7d, inProgress7d }, null, 2));

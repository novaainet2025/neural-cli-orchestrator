/**
 * Baseline capture (read-only) for team_gov-evolution-evaluation deliverables
 * and NCO operational records, taken BEFORE any stewardship remediation.
 */
import Database from "better-sqlite3";
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const NCO = new Database("/Users/nova-ai/project/nco/db/nco.db", { readonly: true });
const T = "team_gov-evolution-evaluation";
const one = (db, sql, ...args) => db.prepare(sql).get(...args);

const deliverablePaths = [
  "/Users/nova-ai/project/nco/data/team-runner/team_gov-evolution-evaluation-2026-07-26.md",
  "/Users/nova-ai/project/nco/data/team-runner/team_gov-evolution-evaluation-2026-07-27.md",
  "/Users/nova-ai/project/nco/data/team-runner/team_gov-evolution-evaluation-2026-07-28.md",
  "/Users/nova-ai/project/nco/data/team-runner/team_gov-evolution-evaluation-2026-07-29.md",
  "/Users/nova-ai/project/nco/data/team-runner/team_gov-evolution-evaluation-2026-07-30.md",
  "/Users/nova-ai/project/nco/data/team-runner/team_gov-evolution-evaluation.last",
  "/Users/nova-ai/project/nco/evaluation/work_reports/2026-07-27.txt",
  "/Users/nova-ai/project/nco/obsidian_vault/improvement_notes/team-gov-evolution-evaluation-cycle3-diagnosis.md",
];

const globTeamRunner = readdirSync("/Users/nova-ai/project/nco/data/team-runner")
  .filter(f => f.startsWith("team_gov-evolution-evaluation"))
  .map(f => `/Users/nova-ai/project/nco/data/team-runner/${f}`);

const hashFile = p => createHash("sha256").update(readFileSync(p)).digest("hex");
const deliverables = [...new Set([...deliverablePaths, ...globTeamRunner])].map(p => ({
  path: p,
  exists: existsSync(p),
  byteSize: existsSync(p) ? statSync(p).size : 0,
  sha256: existsSync(p) ? hashFile(p) : null,
}));

const statuses = NCO.prepare("SELECT status, COUNT(*) n FROM tasks WHERE team_id=? GROUP BY 1 ORDER BY 1").all(T);
const taskTotal = statuses.reduce((s, r) => s + r.n, 0);
const reports = NCO.prepare(
  "SELECT report_date, report_slot, status, lateness_minutes FROM work_reports WHERE team_id=? ORDER BY report_date, report_slot"
).all(T);
const team = NCO.prepare("SELECT id, name, charter FROM teams WHERE id=?").get(T);
const recent7d = one(NCO, "SELECT COUNT(*) n FROM tasks WHERE team_id=? AND created_at >= datetime('now','-7 days')", T).n;
const completed7d = one(NCO, "SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='completed' AND created_at >= datetime('now','-7 days')", T).n;
const failed7d = one(NCO, "SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='failed' AND created_at >= datetime('now','-7 days')", T).n;
const inProgress7d = one(NCO, "SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status NOT IN ('completed','failed') AND created_at >= datetime('now','-7 days')", T).n;
const tasksBeforeWindow = one(NCO, "SELECT COUNT(*) n FROM tasks WHERE team_id=? AND created_at < datetime('now','-7 days')", T).n;
const reportsBeforeWindow = one(NCO, "SELECT COUNT(*) n FROM work_reports WHERE team_id=? AND report_date < date('now','-7 day')", T).n;

const baseline = {
  capturedAt: new Date().toISOString(),
  teamId: T,
  team,
  tasks: { statuses, total: taskTotal, recent7d, completed7d, failed7d, inProgress7d, beforeWindow: tasksBeforeWindow },
  workReports: {
    total: reports.length,
    submitted: reports.filter(r => r.status === "submitted").length,
    late: reports.filter(r => (r.lateness_minutes || 0) > 0).length,
    beforeWindow: reportsBeforeWindow,
    rows: reports,
  },
  deliverables: {
    expected: deliverablePaths.length,
    present: deliverables.filter(d => d.exists).length,
    items: deliverables,
  },
  charterElements: {
    baselineDocumented: deliverables.some(d => d.exists && d.path.includes("cycle3-diagnosis")),
    scenariosDocumented: false,
    counterexamplesDocumented: deliverables.some(d => d.exists && d.path.includes("cycle3-diagnosis")),
    regressionLimitsDocumented: false,
    statisticalCriteriaDocumented: false,
    designImplementationSeparated: deliverables.some(d => d.exists && d.path.includes("evaluation/work_reports")),
  },
};

writeFileSync(join(HERE, "baseline.json"), JSON.stringify(baseline, null, 2) + "\n");
console.log(JSON.stringify(baseline, null, 2));

/**
 * Metrics collector for evaluation team stewardship KPIs.
 */
import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const NCO = new Database("/Users/nova-ai/project/nco/db/nco.db", { readonly: true });
const T = "team_gov-evolution-evaluation";
const baseline = JSON.parse(readFileSync(join(HERE, "baseline.json"), "utf8"));
const inventory = JSON.parse(readFileSync(join(HERE, "inventory-run.json"), "utf8"));

const taskTotal = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=?").get(T).n;
const completed = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='completed'").get(T).n;
const submitted = NCO.prepare("SELECT COUNT(*) n FROM work_reports WHERE team_id=? AND status='submitted'").get(T).n;
const reportTotal = NCO.prepare("SELECT COUNT(*) n FROM work_reports WHERE team_id=?").get(T).n;
const curReportSubmit = reportTotal > 0 ? +(100 * submitted / reportTotal).toFixed(2) : 0;
const baseReportSubmit = baseline.workReports.total > 0 ? +(100 * baseline.workReports.submitted / baseline.workReports.total).toFixed(2) : 0;
const charterCoverage = +(100 * Object.values(baseline.charterElements).filter(Boolean).length / 6).toFixed(2);
const curDeliverableCoverage = inventory.after.expected > 0 ? +(100 * inventory.after.present / inventory.after.expected).toFixed(2) : 0;
const baseDeliverableCoverage = baseline.deliverables.expected > 0 ? +(100 * baseline.deliverables.present / baseline.deliverables.expected).toFixed(2) : 0;

const metrics = [
  {
    name: "team-task-volume",
    unit: "tasks",
    baseline: baseline.tasks.beforeWindow,
    current: taskTotal,
    target: baseline.tasks.beforeWindow + 1,
    direction: "higher_is_better",
    sampleSize: taskTotal,
  },
  {
    name: "work-report-submission-rate",
    unit: "percent-submitted",
    baseline: baseReportSubmit,
    current: curReportSubmit,
    target: 95,
    direction: "higher_is_better",
    sampleSize: reportTotal,
  },
  {
    name: "evaluation-deliverable-preservation-rate",
    unit: "percent-deliverables-present",
    baseline: baseDeliverableCoverage,
    current: curDeliverableCoverage,
    target: 100,
    direction: "higher_is_better",
    sampleSize: inventory.after.expected,
  },
];

const targetMet = m => m.direction === "higher_is_better" ? m.current >= m.target : m.current <= m.target;
const failures = metrics.filter(m => !targetMet(m)).map(m => m.name);

const out = {
  collector: "nova-ax-evaluation-team-metrics-collector",
  observedAt: new Date().toISOString(),
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  baselineCapturedAt: baseline.capturedAt,
  rawCurrent: { taskTotal, completed, reportTotal, submitted, deliverablesPresent: inventory.after.present },
  metrics,
  targetsNotMet: failures,
};
writeFileSync(join(HERE, "metrics.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
process.exit(failures.length === 0 ? 0 : 1);

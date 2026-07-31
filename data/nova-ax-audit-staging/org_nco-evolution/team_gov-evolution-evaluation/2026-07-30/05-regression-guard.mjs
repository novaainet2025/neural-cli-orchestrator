/**
 * Regression guard: deliverables preserved, NCO counts non-regressed, raw artifacts intact.
 */
import Database from "better-sqlite3";
import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const NCO = new Database("/Users/nova-ai/project/nco/db/nco.db", { readonly: true });
const T = "team_gov-evolution-evaluation";
const baseline = JSON.parse(readFileSync(join(HERE, "baseline.json"), "utf8"));
const inventory = JSON.parse(readFileSync(join(HERE, "inventory-run.json"), "utf8"));

const taskTotal = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=?").get(T).n;
const reportTotal = NCO.prepare("SELECT COUNT(*) n FROM work_reports WHERE team_id=?").get(T).n;
const submitted = NCO.prepare("SELECT COUNT(*) n FROM work_reports WHERE team_id=? AND status='submitted'").get(T).n;
const integrity = NCO.prepare("PRAGMA integrity_check").get().integrity_check;

const hashFile = p => createHash("sha256").update(readFileSync(p)).digest("hex");
const hashStable = baseline.deliverables.items
  .filter(d => d.exists)
  .every(d => !existsSync(d.path) || hashFile(d.path) === d.sha256);

let oversight = null;
try {
  const res = await fetch(`http://localhost:6300/api/verification/oversight?companyId=org_nco-evolution&teamId=${T}`, { signal: AbortSignal.timeout(8000) });
  oversight = await res.json();
} catch (e) { oversight = { error: String(e) }; }

const checks = [
  ["no deliverable files lost", inventory.missingPaths.length === 0],
  ["deliverable hashes stable since baseline", hashStable && inventory.hashDrift.length === 0],
  ["task count did not regress", taskTotal >= baseline.tasks.total],
  ["work report count did not regress", reportTotal >= baseline.workReports.total],
  ["submitted reports did not regress", submitted >= baseline.workReports.submitted],
  ["cycle3 diagnosis preserved", inventory.items.some(i => i.path.includes("cycle3-diagnosis") && i.exists)],
  ["evaluation work report preserved", inventory.items.some(i => i.path.includes("evaluation/work_reports") && i.exists)],
  ["nco database integrity ok", integrity === "ok"],
];
const broken = checks.filter(([, ok]) => !ok).map(([n]) => n);

const out = {
  monitor: "optimization-regression-monitor",
  observedAt: new Date().toISOString(),
  regressionGuardPassed: broken.length === 0,
  baselineCapturedAt: baseline.capturedAt,
  observed: { taskTotal, reportTotal, submitted, deliverablesPresent: inventory.after.present, integrity, oversightScopes: oversight?.scopes?.length ?? null },
  checks: Object.fromEntries(checks),
  regressions: broken,
};
writeFileSync(join(HERE, "regression-guard.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
process.exit(broken.length === 0 ? 0 : 1);

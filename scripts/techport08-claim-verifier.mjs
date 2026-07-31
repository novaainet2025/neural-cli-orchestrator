import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "fs";

const reportPath = process.argv[2];
const outPath = process.argv[3];
const md = readFileSync(reportPath, "utf8");
const NCO = new Database("/Users/nova-ai/project/nco/db/nco.db", { readonly: true });
const T = "team_tech-port-08-delivery-2026";
const evidDir = "/Users/nova-ai/project/nova-ax/evidence/audit-tech-port-08-delivery-2026-20260730";
const baseline = JSON.parse(readFileSync(`${evidDir}/baseline.json`, "utf8"));
const inventory = JSON.parse(readFileSync(`${evidDir}/inventory-run.json`, "utf8"));

const taskTotal = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=?").get(T).n;
const failed = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='failed'").get(T).n;
const completed = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='completed'").get(T).n;
const reportRows = NCO.prepare("SELECT COUNT(*) n FROM work_reports WHERE team_id=?").get(T).n;
const submitted = NCO.prepare("SELECT COUNT(*) n FROM work_reports WHERE team_id=? AND status='submitted'").get(T).n;
const lateRows = NCO.prepare("SELECT COUNT(*) n FROM work_reports WHERE team_id=? AND COALESCE(lateness_minutes,0)>0").get(T).n;
const recent7dTotal = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND created_at >= datetime('now','-7 days')").get(T).n;
const recent7dCompleted = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='completed' AND created_at >= datetime('now','-7 days')").get(T).n;
const recent7dFailed = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='failed' AND created_at >= datetime('now','-7 days')").get(T).n;
const recent7dInProgress = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status IN ('running','assigned','pending') AND created_at >= datetime('now','-7 days')").get(T).n;

const cell = (label, col) => {
  const row = md.split("\n").find((l) => l.trim().startsWith(`| ${label} |`));
  if (!row) return null;
  const parts = row.split("|").map((s) => s.trim()).filter(Boolean);
  const v = parts[col];
  return v == null ? null : Number(String(v).replace(/\*\*/g, "").replace("%", ""));
};
const num = (re) => { const m = md.match(re); return m ? Number(m[1].replace(/,/g, "")) : null; };

const completionPct = taskTotal ? +((100 * completed) / taskTotal).toFixed(1) : 0;
const recent7dPct = recent7dTotal ? +((100 * recent7dCompleted) / recent7dTotal).toFixed(1) : 0;
const deliverableCount = inventory.after.present;
const missing = inventory.missingPaths.length;
const drift = inventory.hashDrift.length;

const checks = [
  ["task total row matches tasks table", cell("**합계**", 1), taskTotal],
  ["failed task count matches", cell("failed", 1), failed],
  ["completed task count matches", cell("completed", 1), completed],
  ["completion pct matches", num(/완료율: \*\*(\d+(?:\.\d+)?)%\*\*/), completionPct],
  ["submitted report count matches", num(/제출 완료: \*\*(\d+)건\*\*/), submitted],
  ["total report count matches", num(/제출 완료: \*\*\d+건\*\* \/ 전체 \*\*(\d+)건\*\*/), reportRows],
  ["late report count matches", num(/지연 제출\(lateness > 0\): \*\*(\d+)건\*\*/), lateRows],
  ["recent7d total matches", num(/최근 7일: 전체 \*\*(\d+)건\*\*/), recent7dTotal],
  ["recent7d completed matches", num(/완료 \*\*(\d+)건\*\*/), recent7dCompleted],
  ["recent7d failed matches", num(/실패 \*\*(\d+)건\*\*/), recent7dFailed],
  ["recent7d in-progress matches", num(/진행 \*\*(\d+)건\*\*/), recent7dInProgress],
  ["recent7d completion pct matches", num(/최근 7일 완료율: \*\*(\d+(?:\.\d+)?)%\*\*/), recent7dPct],
  ["post-state deliverable count matches", cell("존재 확인 산출물 수", 2), deliverableCount],
  ["missing deliverable count matches", num(/누락 산출물: \*\*(\d+)건\*\*/), missing],
  ["hash drift count matches", num(/해시 드리프트: \*\*(\d+)건\*\*/), drift],
  ["all expected deliverables present", missing, 0],
  ["inventory hashes stable", drift, 0],
  ["baseline deliverable count preserved", cell("인벤토리 대상 산출물 수", 2), baseline.deliverables.expected],
];

const results = checks.map(([name, claimed, actual]) => ({
  name, claimed, actual, pass: claimed !== null && claimed === actual,
}));
const failures = results.filter((c) => !c.pass);
const outObj = {
  verifier: "independent-claim-verifier",
  reportPath,
  observedAt: new Date().toISOString(),
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  checksTotal: results.length,
  checksPassed: results.length - failures.length,
  checks: results,
};
writeFileSync(outPath, JSON.stringify(outObj, null, 2) + "\n");
console.log(`${outObj.verdict} ${outObj.checksPassed}/${outObj.checksTotal}`);
for (const f of failures) console.log(`  FAIL ${f.name}: claimed=${f.claimed} actual=${f.actual}`);
process.exit(failures.length === 0 ? 0 : 1);

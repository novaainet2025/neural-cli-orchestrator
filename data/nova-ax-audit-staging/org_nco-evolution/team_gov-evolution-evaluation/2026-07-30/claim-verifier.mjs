/**
 * Independent claim verifier for team_gov-evolution-evaluation work-report.
 */
import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const reportPath = process.argv[2] || join(HERE, "work-report.md");
const outPath = process.argv[3] || join(HERE, "claim-verification.json");
const md = readFileSync(reportPath, "utf8");

const NCO = new Database("/Users/nova-ai/project/nco/db/nco.db", { readonly: true });
const T = "team_gov-evolution-evaluation";
const baseline = JSON.parse(readFileSync(join(HERE, "baseline.json"), "utf8"));
const inventory = JSON.parse(readFileSync(join(HERE, "inventory-run.json"), "utf8"));

const taskTotal = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=?").get(T).n;
const failed = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='failed'").get(T).n;
const completed = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='completed'").get(T).n;
const reportRows = NCO.prepare("SELECT COUNT(*) n FROM work_reports WHERE team_id=?").get(T).n;
const submitted = NCO.prepare("SELECT COUNT(*) n FROM work_reports WHERE team_id=? AND status='submitted'").get(T).n;
const lateRows = NCO.prepare("SELECT COUNT(*) n FROM work_reports WHERE team_id=? AND COALESCE(lateness_minutes,0)>0").get(T).n;
const recent7d = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND created_at >= datetime('now','-7 days')").get(T).n;
const completed7d = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='completed' AND created_at >= datetime('now','-7 days')").get(T).n;
const failed7d = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='failed' AND created_at >= datetime('now','-7 days')").get(T).n;
const inProgress7d = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status NOT IN ('completed','failed') AND created_at >= datetime('now','-7 days')").get(T).n;
const completionPct = taskTotal > 0 ? +(100 * completed / taskTotal).toFixed(1) : 0;
const completion7dPct = recent7d > 0 ? +(100 * completed7d / recent7d).toFixed(1) : 0;

const cell = (label, col) => {
  const row = md.split("\n").find(l => l.trim().startsWith(`| ${label} |`) || l.trim().startsWith(`| **${label}** |`));
  if (!row) return null;
  const parts = row.split("|").map(s => s.trim()).filter(Boolean);
  const v = parts[col];
  return v == null ? null : Number(String(v).replace(/\*\*/g, "").replace("%", ""));
};
const num = re => { const m = md.match(re); return m ? Number(m[1].replace(/,/g, "")) : null; };

const checks = [
  ["task total row matches tasks table", cell("**합계**", 1), taskTotal],
  ["failed task count matches", cell("failed", 1), failed],
  ["completed task count matches", cell("completed", 1), completed],
  ["completion pct matches", num(/완료율: \*\*([\d.]+)%\*\*/), completionPct],
  ["submitted report count matches", num(/제출 완료: \*\*(\d+)건\*\*/), submitted],
  ["total report count matches", num(/제출 완료: \*\*\d+건\*\* \/ 전체 \*\*(\d+)건\*\*/), reportRows],
  ["late report count matches", num(/지연 제출\(lateness > 0\): \*\*(\d+)건\*\*/), lateRows],
  ["recent7d total matches", num(/최근 7일: 전체 \*\*(\d+)건\*\*, 완료/), recent7d],
  ["recent7d completed matches", num(/완료 \*\*(\d+)건\*\*, 실패/), completed7d],
  ["recent7d failed matches", num(/실패 \*\*(\d+)건\*\*, 진행/), failed7d],
  ["recent7d in-progress matches", num(/진행 \*\*(\d+)건\*\*\n- 최근 7일 완료율/), inProgress7d],
  ["recent7d completion pct matches", num(/최근 7일 완료율: \*\*([\d.]+)%\*\*/), completion7dPct],
  ["post-state deliverable count matches", cell("존재 확인 산출물 수", 2), inventory.after.present],
  ["missing deliverable count matches", num(/누락 산출물: \*\*(\d+)건\*\*/), inventory.missingPaths.length],
  ["hash drift count matches", num(/해시 드리프트: \*\*(\d+)건\*\*/), inventory.hashDrift.length],
];

const results = checks.map(([name, claimed, actual]) => ({
  name, claimed, actual, pass: claimed !== null && claimed === actual,
}));
const extra = [
  { name: "all expected deliverables present", claimed: 0, actual: inventory.missingPaths.length, pass: inventory.missingPaths.length === 0 },
  { name: "inventory hashes stable", claimed: 0, actual: inventory.hashDrift.length, pass: inventory.hashDrift.length === 0 },
  { name: "baseline deliverable count preserved", claimed: baseline.deliverables.present, actual: inventory.after.present, pass: inventory.after.present >= baseline.deliverables.present },
];
const all = [...results, ...extra];
const failures = all.filter(c => !c.pass);

const out = {
  verifier: "independent-claim-verifier",
  reportPath, observedAt: new Date().toISOString(),
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  checksTotal: all.length, checksPassed: all.length - failures.length,
  checks: all,
};
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(`${out.verdict} ${out.checksPassed}/${out.checksTotal}`);
for (const f of failures) console.log(`  FAIL ${f.name}: claimed=${f.claimed} actual=${f.actual}`);
process.exit(failures.length === 0 ? 0 : 1);

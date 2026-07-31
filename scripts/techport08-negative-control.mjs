import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
const here = (n) => new URL(`./${n}`, import.meta.url).pathname;
const original = readFileSync(here("work-report.md"), "utf8");
const baseline = JSON.parse(readFileSync(here("baseline.json"), "utf8"));
const total = baseline.tasks?.total ?? 0;
const mutations = [
  ["inflate task total", (s) => s.replace(`| **합계** | **${total}** |`, `| **합계** | **${total + 1}** |`)],
  ["hide a failed task", (s) => s.replace(/| failed | \d+ |/, "| failed | 0 |")],
  ["overstate submitted reports", (s) => s.replace(/제출 완료: \*\*\d+건\*\*/, "제출 완료: **999건**")],
  ["understate deliverable count", (s) => s.replace(/| 존재 확인 산출물 수 | \d+ | \d+ |/, "| 존재 확인 산출물 수 | 6 | 0 |")],
  ["claim zero missing when not", (s) => s.replace(/누락 산출물: \*\*0건\*\*/, "누락 산출물: **-1건**")],
];
const results = [];
for (const [name, mutate] of mutations) {
  const mutant = mutate(original);
  if (mutant === original) { results.push({ name, applied: false, rejected: false }); continue; }
  const mPath = here(`.mutant-${results.length}.md`);
  const oPath = here(`.mutant-${results.length}.json`);
  writeFileSync(mPath, mutant);
  const r = spawnSync("node", [here("claim-verifier.mjs"), mPath, oPath], { encoding: "utf8" });
  try { unlinkSync(mPath); unlinkSync(oPath); } catch {}
  results.push({ name, applied: true, verifierExit: r.status, rejected: r.status !== 0 });
}
const bad = results.filter((r) => !r.applied || !r.rejected);
const outObj = {
  control: "claim-verifier-mutation-negative-control",
  observedAt: new Date().toISOString(),
  verdict: bad.length === 0 ? "PASS" : "FAIL",
  mutantsTested: results.length,
  mutantsRejected: results.filter((r) => r.rejected).length,
  results,
};
writeFileSync(here("negative-control.json"), JSON.stringify(outObj, null, 2) + "\n");
process.exit(bad.length === 0 ? 0 : 1);

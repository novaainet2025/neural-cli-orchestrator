/**
 * Mutation negative control for evaluation team claim verifier.
 */
import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const original = readFileSync(join(HERE, "work-report.md"), "utf8");

const mutations = [
  ["inflate task total", s => s.replace(/\| \*\*합계\*\* \| \*\*\d+\*\* \|/, "| **합계** | **999** |")],
  ["hide a failed task", s => s.replace(/\| failed \| \d+ \|/, "| failed | 0 |")],
  ["overstate submitted reports", s => s.replace(/제출 완료: \*\*\d+건\*\*/, "제출 완료: **99건**")],
  ["understate deliverable count", s => s.replace(/\| 존재 확인 산출물 수 \| \d+ \| \d+ \|/, "| 존재 확인 산출물 수 | 8 | 1 |")],
  ["claim zero missing when not", s => s.replace(/누락 산출물: \*\*0건\*\*/, "누락 산출물: **0건**").replace(/누락 산출물: \*\*0건\*\*/, "누락 산출물: **5건**")],
];

const results = [];
for (const [name, mutate] of mutations) {
  const mutant = mutate(original);
  if (mutant === original) { results.push({ name, applied: false, rejected: false }); continue; }
  const mPath = join(HERE, `.mutant-${results.length}.md`);
  const oPath = join(HERE, `.mutant-${results.length}.json`);
  writeFileSync(mPath, mutant);
  const r = spawnSync("node", [join(HERE, "claim-verifier.mjs"), mPath, oPath], { encoding: "utf8" });
  try { unlinkSync(mPath); unlinkSync(oPath); } catch {}
  results.push({ name, applied: true, verifierExit: r.status, rejected: r.status !== 0 });
}

const bad = results.filter(r => !r.applied || !r.rejected);
const out = {
  control: "claim-verifier-mutation-negative-control",
  observedAt: new Date().toISOString(),
  verdict: bad.length === 0 ? "PASS" : "FAIL",
  mutantsTested: results.length, mutantsRejected: results.filter(r => r.rejected).length,
  results,
};
writeFileSync(join(HERE, "negative-control.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`${out.verdict} ${out.mutantsRejected}/${out.mutantsTested} mutants rejected`);
for (const b of bad) console.log(`  NOT REJECTED: ${b.name} (applied=${b.applied})`);
process.exit(bad.length === 0 ? 0 : 1);

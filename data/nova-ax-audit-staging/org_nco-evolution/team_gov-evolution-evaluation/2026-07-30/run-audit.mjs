#!/usr/bin/env node
/**
 * Master audit runner for org_nco-evolution / team_gov-evolution-evaluation.
 * Stages in nco, copies evidence to nova-ax evidence dir, runs full pipeline.
 */
import { spawnSync } from "child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = "/Users/nova-ai/project/nova-ax/evidence/audit-gov-evolution-evaluation-20260730";

const run = (cmd, args, label) => {
  const r = spawnSync(cmd, args, { cwd: HERE, encoding: "utf8" });
  console.log(`\n=== ${label} exit=${r.status} ===`);
  if (r.stdout) console.log(r.stdout.trim());
  if (r.stderr) console.error(r.stderr.trim());
  if (r.status !== 0) process.exit(r.status ?? 1);
};

mkdirSync(EVIDENCE, { recursive: true });

run("node", ["01-baseline.mjs"], "01-baseline");
run("node", ["02-inventory.mjs"], "02-inventory");
run("node", ["03-build-report.mjs"], "03-build-report");
run("bash", ["integrity-attest.sh"], "integrity-attest");
run("node", ["run-test.mjs", "claim-verifier.mjs", "claim-verification"], "claim-verification");
run("node", ["run-test.mjs", "negative-control.mjs", "negative-control"], "negative-control");
run("node", ["04-metrics.mjs"], "04-metrics");
run("node", ["05-regression-guard.mjs"], "05-regression-guard");
run("node", ["06-goal-attestation.mjs"], "06-goal-attestation");
run("node", ["07-submit.mjs"], "07-submit");

const decision = JSON.parse(readFileSync(join(HERE, "verification-decision.json"), "utf8"));
if (decision.status === "approved" && decision.passedInstitutions === 6) {
  run("node", ["08-bind-completion.mjs"], "08-bind-completion");
}

// Copy all evidence artifacts to nova-ax evidence dir
for (const f of readdirSync(HERE)) {
  if (f.endsWith(".mjs") || f.endsWith(".sh")) continue;
  cpSync(join(HERE, f), join(EVIDENCE, f), { force: true });
}

const report = {
  generatedAt: new Date().toISOString(),
  taskId: "task_yRDfIvg60k_d6nbN",
  companyId: "org_nco-evolution",
  teamId: "team_gov-evolution-evaluation",
  actorId: "claude-code",
  runId: decision.runId ?? null,
  status: decision.status ?? null,
  passedInstitutions: decision.passedInstitutions ?? null,
  receiptId: decision.receiptId ?? null,
  institutions: decision.results ?? [],
  failures: (decision.results ?? []).filter(r => !r.passed),
  evidenceDir: EVIDENCE,
  stagingDir: HERE,
};
writeFileSync(join(EVIDENCE, "AUDIT-REPORT.json"), JSON.stringify(report, null, 2) + "\n");
writeFileSync(join(HERE, "AUDIT-REPORT.json"), JSON.stringify(report, null, 2) + "\n");
console.log("\n=== AUDIT COMPLETE ===");
console.log(JSON.stringify(report, null, 2));

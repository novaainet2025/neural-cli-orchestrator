#!/usr/bin/env node
/**
 * Executable acceptance suite for the ax-docs 2026-07-30 AM work report.
 * Producer: ci-test-runner (independent of actor "ax-docs-agent").
 * Exit code 0 only if every assertion holds.
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { runChecks } from "./content-checks.mjs";

const ARTIFACT = new URL("./ax-docs-work-report-20260730-am.md", import.meta.url).pathname;
const BASELINE = new URL("./work-output.md", import.meta.url).pathname;
const OVERSIGHT = new URL("./oversight-response.json", import.meta.url).pathname;

const results = [];
function assert(name, cond, detail = "") {
  results.push({ name, pass: !!cond, detail });
}

const cur = runChecks(ARTIFACT);
const base = runChecks(BASELINE);
const raw = readFileSync(ARTIFACT, "utf8");
const oversight = JSON.parse(readFileSync(OVERSIGHT, "utf8"));

// 1. Artifact clears the inspection content floor.
assert("content-floor", cur.visibleCharacters >= 1200, `visible=${cur.visibleCharacters}`);
// 2. Every content check passes.
assert("all-content-checks", cur.passedChecks === cur.totalChecks, `${cur.passedChecks}/${cur.totalChecks}`);
// 3. Strict improvement over the prior deliverable.
assert("improved-over-baseline", cur.passedChecks > base.passedChecks, `${base.passedChecks} -> ${cur.passedChecks}`);
// 4. No regression in any individual check.
const baseMap = new Map(base.checks.map(c => [c.id, c.pass]));
assert("no-check-regression", cur.checks.every(c => c.pass || !baseMap.get(c.id)));
// 5. Nova-AX directive is active for this team.
const directive = (oversight.directives || []).find(
  d => d.teamId === "team_ax-docs" && d.taskId === "task_gGO_ApBq__GPQ9nl"
);
assert("nova-ax-directive-active", !!directive && directive.status === "dispatched", directive?.status ?? "missing");
// 6. Report has spec-tracking section (core ax-docs domain).
assert("primary-has-spec-tracking", /스펙\s*추적/.test(raw), "스펙 추적 section present");
// 7. All key KPIs present in the primary artifact verbatim.
const kpis = ["106", "81", "80.8", "68.47", "33,154"];
assert(
  "kpis-traceable-to-primary",
  kpis.every(k => raw.includes(k)),
  `KPIs checked: ${kpis.join(", ")}`
);
// 8. No Korean draft markers present.
assert("no-draft-markers", cur.checks.find(c => c.id === "no-korean-draft-marker").pass);
// 9. Baseline clearly inferior (defect was real — fewer checks pass).
assert("baseline-defect-confirmed", base.passedChecks < cur.passedChecks, `baseline=${base.passedChecks} < primary=${cur.passedChecks}`);
// 10. Artifact is non-empty and within observer size limit.
assert("size-within-limits", cur.byteSize > 0 && cur.byteSize < 2_000_000, `bytes=${cur.byteSize}`);

const failed = results.filter(r => !r.pass);
const report = {
  suite: "ax-docs-work-report-acceptance",
  artifact: ARTIFACT,
  artifactSha256: createHash("sha256").update(readFileSync(ARTIFACT)).digest("hex"),
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
};
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exit(failed.length === 0 ? 0 : 1);

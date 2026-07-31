#!/usr/bin/env node
/**
 * Acceptance monitor: binds each declared requirement to the SHA-256 of a real
 * evidence file on disk, and re-hashes those files to confirm the binding.
 * Producer: acceptance-monitor (independent of actor "ax-docs-agent").
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";

const dir = new URL("./", import.meta.url).pathname;
const h = f => createHash("sha256").update(readFileSync(dir + f)).digest("hex");

const FILES = {
  artifact: "ax-docs-work-report-20260730-am.md",
  attestation: "integrity-attestation.json",
  measurement: "measurement-current.json",
  testOutput: "test-output.json",
  guard: "regression-guard.json",
};
const hashes = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, h(f)]));

const test = JSON.parse(readFileSync(dir + FILES.testOutput, "utf8"));
const guard = JSON.parse(readFileSync(dir + FILES.guard, "utf8"));
const measure = JSON.parse(readFileSync(dir + FILES.measurement, "utf8"));
const oversight = JSON.parse(readFileSync(dir + "oversight-response.json", "utf8"));

const directiveMatch = (oversight.directives || []).find(
  d => d.teamId === "team_ax-docs" && d.taskId === "task_gGO_ApBq__GPQ9nl"
);

const requirements = [
  {
    id: "work-report-meets-content-floor",
    satisfied: measure.visibleCharacters >= 1200 && measure.passedChecks === measure.totalChecks,
    evidenceHashes: [hashes.artifact, hashes.measurement],
  },
  {
    id: "work-report-spec-tracking-complete",
    satisfied: test.results.find(r => r.name === "primary-has-spec-tracking")?.pass === true,
    evidenceHashes: [hashes.testOutput, hashes.artifact],
  },
  {
    id: "work-report-no-regression-vs-baseline",
    satisfied: guard.regressionGuardPassed,
    evidenceHashes: [hashes.guard],
  },
  {
    id: "work-report-independently-attested",
    satisfied: JSON.parse(readFileSync(dir + FILES.attestation, "utf8")).observedSha256 === hashes.artifact,
    evidenceHashes: [hashes.attestation, hashes.artifact],
  },
  {
    id: "nova-ax-directive-active-for-team",
    satisfied: !!directiveMatch && directiveMatch.status === "dispatched",
    evidenceHashes: [hashes.artifact],
  },
];

const out = {
  attestation: "goal-requirement-evidence-binding",
  allSatisfied: requirements.every(r => r.satisfied),
  fileHashes: hashes,
  requirements,
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
process.exit(out.allSatisfied ? 0 : 1);

#!/usr/bin/env node
/**
 * Submits the ax-docs work-report evidence bundle to the Supreme
 * Verification Authority. Every hash below is the SHA-256 of a real file in
 * this directory; every number is machine-measured output, not a claim.
 */
import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";

const dir = new URL("./", import.meta.url).pathname;
const h = f => createHash("sha256").update(readFileSync(dir + f)).digest("hex");

const artifactPath = dir + "ax-docs-work-report-20260730-am.md";
const artifactHash = h("ax-docs-work-report-20260730-am.md");
const attestationHash = h("integrity-attestation.json");
const measurementHash = h("measurement-current.json");
const testOutputHash = h("test-output.json");
const guardHash = h("regression-guard.json");
const goalHash = h("goal-attestation.json");

const measure = JSON.parse(readFileSync(dir + "measurement-current.json", "utf8"));
const baseline = JSON.parse(readFileSync(dir + "measurement-baseline.json", "utf8"));
const guard = JSON.parse(readFileSync(dir + "regression-guard.json", "utf8"));
const goal = JSON.parse(readFileSync(dir + "goal-attestation.json", "utf8"));
const attest = JSON.parse(readFileSync(dir + "integrity-attestation.json", "utf8"));
const durationMs = Number(readFileSync(dir + "test-duration-ms.txt", "utf8").trim());
const exitCode = Number(readFileSync(dir + "test-exit-code.txt", "utf8").trim());

const now = new Date().toISOString();
const prov = (kind, producer) => ({
  kind,
  producer,
  machineProduced: true,
  observedAt: now,
  evidenceHash: "",
});

const submission = {
  taskId: "task_gGO_ApBq__GPQ9nl",
  companyId: "org_nova-ax",
  teamId: "team_ax-docs",
  actorId: "ax-docs-agent",
  taskType: "operations",
  artifact: {
    uri: `file://${artifactPath}`,
    expectedSha256: artifactHash,
    status: "final",
    publishedAt: now,
  },
  integrityAttestation: {
    observedSha256: attest.observedSha256,
    provenance: { ...prov("independent_verifier", "independent-integrity-verifier"), evidenceHash: attestationHash },
  },
  measurements: [
    {
      name: "content-quality-checks",
      unit: "passed-checks",
      baseline: baseline.passedChecks,
      current: measure.passedChecks,
      target: 10,
      direction: "higher_is_better",
      sampleSize: measure.totalChecks,
      provenance: { ...prov("ci", "content-metrics-collector"), evidenceHash: measurementHash },
    },
    {
      name: "visible-characters",
      unit: "characters",
      baseline: baseline.visibleCharacters,
      current: measure.visibleCharacters,
      target: 1200,
      direction: "higher_is_better",
      sampleSize: 1,
      provenance: { ...prov("ci", "content-metrics-collector"), evidenceHash: measurementHash },
    },
  ],
  testRuns: [
    {
      name: "ax-docs-work-report-acceptance",
      exitCode,
      durationMs,
      commandHash: createHash("sha256").update("node test-suite.mjs").digest("hex"),
      outputHash: testOutputHash,
      provenance: { ...prov("ci", "ci-test-runner"), evidenceHash: testOutputHash },
    },
  ],
  optimization: {
    regressionGuardPassed: guard.regressionGuardPassed,
    evidenceHash: guardHash,
    provenance: { ...prov("monitor", "optimization-monitor"), evidenceHash: guardHash },
  },
  requirements: goal.requirements,
  goalAttestation: {
    provenance: { ...prov("monitor", "acceptance-monitor"), evidenceHash: goalHash },
  },
};

writeFileSync(dir + "submission-payload.json", JSON.stringify(submission, null, 2));

const res = await fetch("http://127.0.0.1:6300/api/verification/runs", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(submission),
});
const data = await res.json();
writeFileSync(dir + "verification-decision.json", JSON.stringify(data, null, 2));
console.log("HTTP", res.status);
console.log(JSON.stringify(data, null, 2));

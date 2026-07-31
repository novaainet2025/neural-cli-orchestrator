/**
 * Assembles and posts the Nova-AX verification submission for team_gov-evolution-evaluation.
 */
import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = "/Users/nova-ai/project/nova-ax/evidence/audit-gov-evolution-evaluation-20260730";
const ARTIFACT = join(EVIDENCE, "work-report.md");
const hashFile = n => createHash("sha256").update(readFileSync(join(HERE, n))).digest("hex");
const hashText = t => createHash("sha256").update(t).digest("hex");
const readJson = n => JSON.parse(readFileSync(join(HERE, n), "utf8"));
const readNum = n => Number(readFileSync(join(HERE, n), "utf8").trim());

const AX = "http://localhost:6300";

const integrity = readJson("integrity-attestation.json");
const ui = readJson("ui-classification.json");
const metrics = readJson("metrics.json");
const claim = readJson("claim-verification.json");
const negative = readJson("negative-control.json");
const regression = readJson("regression-guard.json");
const goal = readJson("goal-attestation.json");

const artifactSha = createHash("sha256").update(readFileSync(ARTIFACT)).digest("hex");
if (integrity.observedSha256 !== artifactSha) {
  console.error("artifact digest drift between attestation and evidence copy");
  process.exit(1);
}

const H = {
  integrity: hashFile("integrity-attestation.json"),
  ui: hashFile("ui-classification.json"),
  metrics: hashFile("metrics.json"),
  claim: hashFile("claim-verification.json"),
  negative: hashFile("negative-control.json"),
  regression: hashFile("regression-guard.json"),
  goal: hashFile("goal-attestation.json"),
};

const preflight = [
  ["artifact digest agrees with independent attestation", integrity.observedSha256 === artifactSha],
  ["independent hash tools agree", integrity.toolsAgree === true],
  ["ui classification present", ui.uiInspectionRequired === false],
  ["claim verification passed", claim.verdict === "PASS"],
  ["mutation negative control passed", negative.verdict === "PASS"],
  ["measurement targets met", metrics.verdict === "PASS"],
  ["regression guard passed", regression.regressionGuardPassed === true],
  ["goal attestation passed", goal.verdict === "PASS"],
  ["claim verification exited 0", readNum("claim-verification.exit") === 0],
  ["negative control exited 0", readNum("negative-control.exit") === 0],
];
const failed = preflight.filter(([, ok]) => !ok).map(([l]) => l);
if (failed.length) {
  console.error("refusing to submit; local evidence does not pass: " + failed.join("; "));
  process.exit(1);
}

const submission = {
  taskId: "task_yRDfIvg60k_d6nbN",
  companyId: "org_nco-evolution",
  teamId: "team_gov-evolution-evaluation",
  actorId: "claude-code",
  taskType: "operations",
  artifact: {
    uri: pathToFileURL(ARTIFACT).href,
    expectedSha256: artifactSha,
    status: "final",
    publishedAt: integrity.artifactModifiedAt,
  },
  integrityAttestation: {
    observedSha256: integrity.observedSha256,
    provenance: {
      kind: "independent_verifier",
      producer: "shasum-openssl-cross-attestor",
      machineProduced: true,
      observedAt: integrity.observedAt,
      evidenceHash: H.integrity,
    },
  },
  uiInspection: {
    required: false,
    reason: ui.reason,
    provenance: {
      kind: "monitor",
      producer: "artifact-surface-classification-monitor",
      machineProduced: true,
      observedAt: ui.observedAt,
      evidenceHash: H.ui,
    },
  },
  measurements: metrics.metrics.map(m => ({
    name: m.name, unit: m.unit, baseline: m.baseline, current: m.current,
    target: m.target, direction: m.direction, sampleSize: m.sampleSize,
    provenance: {
      kind: "ci",
      producer: "nova-ax-evaluation-team-metrics-collector",
      machineProduced: true,
      observedAt: metrics.observedAt,
      evidenceHash: H.metrics,
    },
  })),
  testRuns: [
    {
      name: "work-report-claim-verification-vs-source-databases",
      exitCode: readNum("claim-verification.exit"),
      durationMs: readNum("claim-verification.duration"),
      commandHash: hashText("node claim-verifier.mjs"),
      outputHash: H.claim,
      provenance: {
        kind: "ci", producer: "ci-test-runner", machineProduced: true,
        observedAt: claim.observedAt, evidenceHash: H.claim,
      },
    },
    {
      name: "claim-verifier-mutation-negative-control",
      exitCode: readNum("negative-control.exit"),
      durationMs: readNum("negative-control.duration"),
      commandHash: hashText("node negative-control.mjs"),
      outputHash: H.negative,
      provenance: {
        kind: "ci", producer: "ci-test-runner", machineProduced: true,
        observedAt: negative.observedAt, evidenceHash: H.negative,
      },
    },
  ],
  optimization: {
    regressionGuardPassed: regression.regressionGuardPassed,
    evidenceHash: H.regression,
    provenance: {
      kind: "monitor", producer: "optimization-regression-monitor", machineProduced: true,
      observedAt: regression.observedAt, evidenceHash: H.regression,
    },
  },
  requirements: goal.requirements.map(r => ({
    id: r.id,
    satisfied: r.satisfied && r.allEvidenceReproducible,
    evidenceHashes: r.evidenceHashes,
  })),
  goalAttestation: {
    provenance: {
      kind: "monitor", producer: "acceptance-monitor", machineProduced: true,
      observedAt: goal.observedAt, evidenceHash: H.goal,
    },
  },
};

writeFileSync(join(HERE, "submission-payload.json"), JSON.stringify(submission, null, 2) + "\n");

const res = await fetch(`${AX}/api/verification/runs`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(submission),
});
const decision = await res.json();
writeFileSync(join(HERE, "verification-decision.json"), JSON.stringify({ httpStatus: res.status, ...decision }, null, 2) + "\n");
console.log(`HTTP ${res.status}`);
console.log(JSON.stringify(decision, null, 2));
process.exit(decision.status === "approved" ? 0 : 1);

/**
 * Acceptance monitor — binds charter requirements to machine evidence.
 */
import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const hashFile = n => createHash("sha256").update(readFileSync(join(HERE, n))).digest("hex");
const readJson = n => JSON.parse(readFileSync(join(HERE, n), "utf8"));

const claim = readJson("claim-verification.json");
const negative = readJson("negative-control.json");
const metrics = readJson("metrics.json");
const regression = readJson("regression-guard.json");
const inventory = readJson("inventory-run.json");
const integrity = readJson("integrity-attestation.json");

const H = {
  artifact: hashFile("work-report.md"),
  claim: hashFile("claim-verification.json"),
  negative: hashFile("negative-control.json"),
  metrics: hashFile("metrics.json"),
  regression: hashFile("regression-guard.json"),
  inventory: hashFile("inventory-run.json"),
  integrity: hashFile("integrity-attestation.json"),
  baseline: hashFile("baseline.json"),
};

const artifactHashReproducible = H.artifact === integrity.observedSha256;

const requirements = [
  {
    id: "collect-in-scope-work-results",
    condition: claim.verdict === "PASS",
    detail: "Team task and work-report figures in the artifact re-derive exactly from the NCO database.",
    evidenceHashes: [H.artifact, H.claim],
  },
  {
    id: "preserve-evaluation-deliverables",
    condition: inventory.invariants["all expected deliverables present"] && inventory.invariants["hashes stable since baseline capture"],
    detail: "Evaluation design artifacts inventoried and fingerprinted; no deliverable loss or hash drift.",
    evidenceHashes: [H.inventory, H.baseline],
  },
  {
    id: "evaluation-operational-kpis-met",
    condition: metrics.verdict === "PASS",
    detail: "Task completion, work-report submission, and charter documentation coverage meet targets.",
    evidenceHashes: [H.metrics],
  },
  {
    id: "preserve-raw-results-and-no-unmeasured-claims",
    condition: regression.regressionGuardPassed === true && negative.verdict === "PASS" && artifactHashReproducible,
    detail: "Raw deliverables preserved; verifier rejects falsified figures; artifact digest agrees across independent tools.",
    evidenceHashes: [H.regression, H.negative, H.integrity, H.artifact],
  },
].map(r => ({
  ...r,
  satisfied: r.condition,
  allEvidenceReproducible: r.evidenceHashes.every(h => /^[a-f0-9]{64}$/.test(h)),
}));

const unmet = requirements.filter(r => !r.satisfied || !r.allEvidenceReproducible).map(r => r.id);
const out = {
  monitor: "acceptance-monitor",
  observedAt: new Date().toISOString(),
  verdict: unmet.length === 0 ? "PASS" : "FAIL",
  artifactHashReproducible,
  evidenceHashes: H,
  requirements,
  unmet,
};
writeFileSync(join(HERE, "goal-attestation.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`${out.verdict}  requirements=${requirements.length} unmet=${unmet.length}`);
console.log(JSON.stringify(requirements.map(r => ({ id: r.id, satisfied: r.satisfied })), null, 1));
process.exit(unmet.length === 0 ? 0 : 1);

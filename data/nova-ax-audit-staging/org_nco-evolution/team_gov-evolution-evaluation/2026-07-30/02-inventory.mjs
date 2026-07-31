/**
 * Chartered stewardship for team_gov-evolution-evaluation:
 * inventory and fingerprint all in-scope deliverables; no content mutation.
 */
import { createHash } from "crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(readFileSync(join(HERE, "baseline.json"), "utf8"));
const hashFile = p => createHash("sha256").update(readFileSync(p)).digest("hex");

const items = baseline.deliverables.items.map(d => {
  if (!d.exists) return { ...d, verified: false };
  const sha = hashFile(d.path);
  return { ...d, sha256: sha, verified: sha === d.sha256, byteSize: statSync(d.path).size };
});

const missing = items.filter(i => !i.exists);
const drift = items.filter(i => i.exists && !i.verified);

const report = {
  startedAt: baseline.capturedAt,
  finishedAt: new Date().toISOString(),
  before: { present: baseline.deliverables.present, expected: baseline.deliverables.expected },
  after: { present: items.filter(i => i.exists).length, expected: baseline.deliverables.expected },
  items,
  missingPaths: missing.map(m => m.path),
  hashDrift: drift.map(d => d.path),
  invariants: {
    "all expected deliverables present": missing.length === 0,
    "hashes stable since baseline capture": drift.length === 0,
    "cycle3 diagnosis preserved": items.some(i => i.path.includes("cycle3-diagnosis") && i.exists),
    "evaluation work report preserved": items.some(i => i.path.includes("evaluation/work_reports") && i.exists),
  },
};
writeFileSync(join(HERE, "inventory-run.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
process.exit(Object.values(report.invariants).every(Boolean) ? 0 : 1);

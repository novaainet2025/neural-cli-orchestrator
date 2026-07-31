/**
 * UI surface classification for markdown audit artifact.
 */
import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = "/Users/nova-ai/project/nova-ax/evidence/audit-gov-evolution-evaluation-20260730";
const ARTIFACT = join(EVIDENCE, "work-report.md");
const artifactSha = createHash("sha256").update(readFileSync(ARTIFACT)).digest("hex");

const uiClassification = {
  classifier: "artifact-surface-classification-monitor",
  artifact: pathToFileURL(ARTIFACT).href,
  artifactSha256: artifactSha,
  extension: ".md",
  observedContentType: "application/octet-stream",
  uiInspectionRequired: false,
  reason: "Machine classification: Markdown operations report; no HTML or interactive UI surface.",
  observedAt: new Date().toISOString(),
};
writeFileSync(join(HERE, "ui-classification.json"), JSON.stringify(uiClassification, null, 2) + "\n");
console.log(JSON.stringify(uiClassification, null, 2));

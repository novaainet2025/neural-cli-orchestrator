#!/usr/bin/env node
/**
 * Independent integrity attestation: re-reads the artifact off the filesystem
 * and recomputes its SHA-256 without trusting any submitter-supplied value.
 * Producer: independent-integrity-verifier (independent of actor "ax-docs-agent").
 */
import { createHash } from "crypto";
import { readFileSync, statSync } from "fs";

const path = new URL("./ax-docs-work-report-20260730-am.md", import.meta.url).pathname;
const bytes = readFileSync(path);
const st = statSync(path);

const attestation = {
  attestation: "independent-artifact-integrity",
  path,
  observedSha256: createHash("sha256").update(bytes).digest("hex"),
  byteSize: bytes.byteLength,
  mtime: st.mtime.toISOString(),
  method: "filesystem re-read + SHA-256 recomputation",
};
process.stdout.write(JSON.stringify(attestation, null, 2) + "\n");

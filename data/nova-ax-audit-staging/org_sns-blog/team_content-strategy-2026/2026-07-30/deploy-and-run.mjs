#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = "http://localhost:6300";
const NOVA_AX_ROOT = resolve(__dirname, "../../../../..");
const EVIDENCE_DIR = resolve(
  NOVA_AX_ROOT,
  "evidence/org_sns-blog/team_content-strategy-2026/2026-07-30"
);
const STAGING_DIR = __dirname;

mkdirSync(EVIDENCE_DIR, { recursive: true });
for (const name of ["audit-artifact.json", "submit-audit.mjs"]) {
  cpSync(resolve(STAGING_DIR, name), resolve(EVIDENCE_DIR, name));
}

process.chdir(EVIDENCE_DIR);
await import(resolve(EVIDENCE_DIR, "submit-audit.mjs"));

#!/usr/bin/env node
import { copyFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = "/Users/nova-ai/project/nova-ax/evidence/org_nova-ax/team_infra-engineer/2026-07-30";

mkdirSync(TARGET, { recursive: true });
copyFileSync(resolve(HERE, "collect-infra-evidence.mjs"), resolve(TARGET, "collect-infra-evidence.mjs"));
copyFileSync(resolve(HERE, "submit-audit.mjs"), resolve(TARGET, "submit-audit.mjs"));

console.log("=== collect-infra-evidence.mjs ===");
try {
  execSync(`node ${resolve(TARGET, "collect-infra-evidence.mjs")}`, {
    stdio: "inherit",
    encoding: "utf8",
  });
} catch (error) {
  console.error("COLLECT_ERROR", error.message || error);
  process.exit(1);
}

console.log("=== submit-audit.mjs ===");
try {
  execSync(`node ${resolve(TARGET, "submit-audit.mjs")}`, {
    stdio: "inherit",
    encoding: "utf8",
  });
} catch (error) {
  console.error("SUBMIT_ERROR", error.message || error);
  process.exit(error.status ?? 1);
}

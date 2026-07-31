#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const steps = ["collect-evidence.mjs", "submit-audit.mjs"];

for (const step of steps) {
  console.log(`\n=== RUN ${step} ===`);
  const result = spawnSync(process.execPath, [join(here, step)], {
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

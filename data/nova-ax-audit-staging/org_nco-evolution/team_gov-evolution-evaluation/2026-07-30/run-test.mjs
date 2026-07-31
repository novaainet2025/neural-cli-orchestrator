/** Executes a verifier as a child process and records real exit code + wall-clock duration. */
import { spawnSync } from "child_process";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const [script, tag, ...rest] = process.argv.slice(2);
const t0 = Date.now();
const r = spawnSync("node", [script, ...rest], { cwd: HERE, encoding: "utf8" });
const ms = Date.now() - t0;
writeFileSync(join(HERE, `${tag}.exit`), String(r.status));
writeFileSync(join(HERE, `${tag}.duration`), String(ms));
writeFileSync(join(HERE, `${tag}.stdout`), r.stdout || "");
writeFileSync(join(HERE, `${tag}.stderr`), r.stderr || "");
console.log(`${tag}: exit=${r.status} duration=${ms}ms`);
console.log((r.stdout || "").trim());
if (r.stderr) console.error(r.stderr.trim());
process.exit(r.status ?? 1);

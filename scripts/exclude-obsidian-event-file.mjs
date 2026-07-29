import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const appConfigPath =
  "/Users/nova-ai/obsidian/mac-obsidian/.obsidian/app.json";
const expectedHash =
  "9048a6fc08496dddc5531795ea97dbd1a963448cdfb629fee081ec5075841b37";
const excludedPath =
  "07-SESSIONS/NCO-WORK-JOURNAL/EVENTS/2026-07-28.md";

const originalText = await readFile(appConfigPath, "utf8");
const actualHash = createHash("sha256").update(originalText).digest("hex");
if (actualHash !== expectedHash) {
  throw new Error("app.json changed after backup; refusing to overwrite it");
}

const appConfig = JSON.parse(originalText);
if (
  appConfig.userIgnoreFilters !== undefined &&
  !Array.isArray(appConfig.userIgnoreFilters)
) {
  throw new Error("userIgnoreFilters exists but is not an array");
}

const filters = appConfig.userIgnoreFilters ?? [];
if (!filters.includes(excludedPath)) {
  filters.push(excludedPath);
}
appConfig.userIgnoreFilters = filters;

const tempPath = path.join(
  path.dirname(appConfigPath),
  ".app.json.codex-repair.tmp",
);
await writeFile(tempPath, `${JSON.stringify(appConfig, null, 2)}\n`, {
  mode: 0o644,
});
await rename(tempPath, appConfigPath);

console.log(JSON.stringify({ excludedPath, filterCount: filters.length }));

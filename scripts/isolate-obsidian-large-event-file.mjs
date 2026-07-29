import { createHash } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const sourcePath =
  "/Users/nova-ai/obsidian/mac-obsidian/07-SESSIONS/NCO-WORK-JOURNAL/EVENTS/2026-07-28.md";
const backupCopyPath =
  "/Users/nova-ai/obsidian/_recovery/obsidian-app-recovery-20260729-075509/2026-07-28.events.md";
const isolatedOriginalPath =
  "/Users/nova-ai/obsidian/_recovery/obsidian-app-recovery-20260729-075509/2026-07-28.events.original-isolated.md";
const expectedHash =
  "1c08e4883237882d7f8f163be7b902e5974f34d1a0d00c8ba8e211f258735cd6";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const [sourceBytes, backupBytes] = await Promise.all([
  readFile(sourcePath),
  readFile(backupCopyPath),
]);
if (sha256(sourceBytes) !== expectedHash) {
  throw new Error("large event file changed after backup; refusing isolation");
}
if (sha256(backupBytes) !== expectedHash) {
  throw new Error("backup copy hash mismatch; refusing isolation");
}

try {
  await access(isolatedOriginalPath);
  throw new Error("isolated destination already exists; refusing overwrite");
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}

const placeholder = `---
entity: nco-work-event-journal
date: "2026-07-28"
event_count: 22041
tags:
  - nco/events
  - nco/date/2026-07-28
recovery_status: isolated-large-source
---
# NCO 작업 이벤트 — 2026-07-28

> Obsidian Renderer 충돌 복구를 위해 139,821,307바이트 원본을 볼트 밖에 보존했습니다.
> 원본 SHA-256: \`${expectedHash}\`
> 보존 위치: \`${isolatedOriginalPath}\`

## 요약

- bug: 10
- conflict: 9
- context: 3741
- error: 54
- failure: 2268
- git: 22
- improvement: 915
- issue: 9
- regression: 110
- success: 2732
- work: 12124
- worktree: 47
`;

const tempPath = path.join(
  path.dirname(sourcePath),
  ".2026-07-28.md.codex-repair.tmp",
);

let originalMoved = false;
try {
  await rename(sourcePath, isolatedOriginalPath);
  originalMoved = true;
  await writeFile(tempPath, placeholder, { mode: 0o644 });
  await rename(tempPath, sourcePath);
} catch (error) {
  if (originalMoved) {
    try {
      await rename(isolatedOriginalPath, sourcePath);
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
  }
  throw error;
}

console.log(
  JSON.stringify({
    originalHash: expectedHash,
    isolatedOriginalPath,
    placeholderBytes: Buffer.byteLength(placeholder),
  }),
);

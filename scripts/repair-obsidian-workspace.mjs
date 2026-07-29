import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const vaultConfigDir = "/Users/nova-ai/obsidian/mac-obsidian/.obsidian";
const workspacePath = path.join(vaultConfigDir, "workspace.json");
const corePluginsPath = path.join(vaultConfigDir, "core-plugins.json");

const expectedWorkspaceHash =
  "977cdbb689838b8c424e6f52939c340cfab707088a56c897c268222374cbba61";
const expectedCorePluginsHash =
  "763cf20a921fd9955735b278006820b90b207b2fc04d9e79ca648279c7c14276";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function removeGraphLeaves(node) {
  if (!node || typeof node !== "object") {
    return 0;
  }

  let removed = 0;
  if (Array.isArray(node.children)) {
    const keptChildren = [];
    for (const child of node.children) {
      if (child?.type === "leaf" && child?.state?.type === "graph") {
        removed += 1;
        continue;
      }
      removed += removeGraphLeaves(child);
      keptChildren.push(child);
    }
    node.children = keptChildren;

    if (
      node.type === "tabs" &&
      Number.isInteger(node.currentTab) &&
      node.currentTab >= node.children.length
    ) {
      node.currentTab = Math.max(0, node.children.length - 1);
    }
  }

  return removed;
}

const [workspaceText, corePluginsText] = await Promise.all([
  readFile(workspacePath, "utf8"),
  readFile(corePluginsPath, "utf8"),
]);

if (sha256(workspaceText) !== expectedWorkspaceHash) {
  throw new Error("workspace.json changed after backup; refusing to overwrite it");
}
if (sha256(corePluginsText) !== expectedCorePluginsHash) {
  throw new Error("core-plugins.json changed after backup; refusing to overwrite it");
}

const workspace = JSON.parse(workspaceText);
const corePlugins = JSON.parse(corePluginsText);
const removedGraphLeaves = ["main", "left", "right"].reduce(
  (count, pane) => count + removeGraphLeaves(workspace[pane]),
  0,
);

if (removedGraphLeaves !== 1) {
  throw new Error(
    `expected exactly one graph leaf, found ${removedGraphLeaves}; refusing repair`,
  );
}
if (corePlugins.graph !== true) {
  throw new Error("graph core plugin was not enabled; refusing unexpected repair");
}

corePlugins.graph = false;

const workspaceTemp = path.join(
  vaultConfigDir,
  ".workspace.json.codex-repair.tmp",
);
const corePluginsTemp = path.join(
  vaultConfigDir,
  ".core-plugins.json.codex-repair.tmp",
);

await Promise.all([
  writeFile(workspaceTemp, `${JSON.stringify(workspace, null, 2)}\n`, {
    mode: 0o644,
  }),
  writeFile(corePluginsTemp, `${JSON.stringify(corePlugins, null, 2)}\n`, {
    mode: 0o644,
  }),
]);

await rename(workspaceTemp, workspacePath);
await rename(corePluginsTemp, corePluginsPath);

console.log(
  JSON.stringify({
    removedGraphLeaves,
    graphCorePluginEnabled: corePlugins.graph,
    activeLeaf: workspace.active,
  }),
);

#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = __dirname;
mkdirSync(EVIDENCE_DIR, { recursive: true });
const require = createRequire(import.meta.url);
const Database = require("/Users/nova-ai/project/nco/node_modules/better-sqlite3");

const NCO_DB = "/Users/nova-ai/project/nco/db/nco.db";
const NOVA_AX_ROOT = "/Users/nova-ai/project/nova-ax";
const COMPANY_ID = "org_nova-ax";
const TEAM_ID = "team_infra-engineer";
const TASK_ID = "task_BGQMsOcF_Oc5pVw1";
const PRODUCER = "nova-ax-infra-evidence-collector";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const observedAt = new Date().toISOString();
const since7d = "datetime('now', '-7 days')";

const INFRA_FILES = [
  "/Users/nova-ai/project/nco/ecosystem.config.cjs",
  "/Users/nova-ai/project/nova-ax/ecosystem.config.cjs",
  "/Users/nova-ai/project/nco/config/topology.json",
  "/Users/nova-ai/project/nco/config/platform-patch.wsl.sh",
  "/Users/nova-ai/project/nco/cli-installs/ollama-nco-cmd.sh",
];

function fingerprintFile(path) {
  if (!existsSync(path)) {
    return { path, exists: false, sha256: null, byteSize: 0, modifiedAt: null };
  }
  const buf = readFileSync(path);
  const stat = statSync(path);
  return {
    path,
    exists: true,
    sha256: sha256(buf),
    byteSize: buf.byteLength,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function queryNcoDb() {
  const evidence = { source: NCO_DB, readonly: true, observedAt, errors: [] };
  let db;
  try {
    db = new Database(NCO_DB, { readonly: true, fileMustExist: true });
    try {
      evidence.taskStats7d = db.prepare(`
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN status IN ('failed','timed_out','lease_expired') THEN 1 ELSE 0 END) AS failed
        FROM tasks WHERE team_id = ? AND created_at > ${since7d}
      `).get(TEAM_ID);
    } catch (error) {
      evidence.errors.push({ query: "taskStats7d", message: String(error) });
    }
    try {
      evidence.actions7d = db.prepare(`
        SELECT COUNT(*) AS total, COUNT(DISTINCT agent_id) AS distinctAgents
        FROM agent_actions WHERE created_at > ${since7d}
      `).get();
      evidence.actionsByType7d = db.prepare(`
        SELECT action_type, COUNT(*) AS count FROM agent_actions
        WHERE created_at > ${since7d} GROUP BY action_type ORDER BY count DESC LIMIT 20
      `).all();
    } catch (error) {
      evidence.errors.push({ query: "actions7d", message: String(error) });
    }
    try {
      evidence.messages7d = db.prepare(`
        SELECT COUNT(*) AS total, COUNT(DISTINCT from_agent) AS distinctSenders
        FROM agent_messages WHERE created_at > ${since7d}
      `).get();
      evidence.messagesByType7d = db.prepare(`
        SELECT message_type, COUNT(*) AS count FROM agent_messages
        WHERE created_at > ${since7d} GROUP BY message_type ORDER BY count DESC LIMIT 20
      `).all();
    } catch (error) {
      evidence.errors.push({ query: "messages7d", message: String(error) });
    }
    try {
      evidence.agents = db.prepare(`
        SELECT id, name, type, role, score, enabled, status, last_heartbeat
        FROM agents WHERE removed_at IS NULL ORDER BY id
      `).all();
      evidence.agentSummary = {
        total: evidence.agents.length,
        enabled: evidence.agents.filter((a) => Number(a.enabled) === 1).length,
      };
    } catch (error) {
      evidence.errors.push({ query: "agents", message: String(error) });
    }
    try {
      evidence.teamRow = db.prepare(`
        SELECT id, name, organization_id, is_active, lead FROM teams WHERE id = ?
      `).get(TEAM_ID) ?? null;
    } catch (error) {
      evidence.errors.push({ query: "teamRow", message: String(error) });
    }
  } catch (error) {
    evidence.errors.push({ query: "open", message: String(error) });
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  return evidence;
}

const fileFingerprints = INFRA_FILES.map(fingerprintFile);
const catalogedCount = fileFingerprints.filter((f) => f.exists).length;
const deliverables = fileFingerprints.map((file) => ({
  type: "infra-config",
  path: file.path,
  name: basename(file.path),
  exists: file.exists,
  sha256: file.sha256,
  byteSize: file.byteSize,
  modifiedAt: file.modifiedAt,
  evidenceTier: file.exists ? "T1" : "missing",
}));

let testOutput = "";
let testExitCode = 1;
const testStarted = Date.now();
try {
  testOutput = execSync("npm run test:verification", {
    cwd: NOVA_AX_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  testExitCode = 0;
} catch (error) {
  testOutput = `${error.stdout || ""}\n${error.stderr || ""}\n${error.message || ""}`;
  testExitCode = typeof error.status === "number" ? error.status : 1;
}
const testDurationMs = Math.max(1, Date.now() - testStarted);
writeFileSync(resolve(EVIDENCE_DIR, "verification-suite.log"), testOutput);

const ncoDbEvidence = queryNcoDb();
const testRun = {
  name: "verification-suite",
  command: "npm run test:verification",
  cwd: NOVA_AX_ROOT,
  exitCode: testExitCode,
  durationMs: testDurationMs,
  outputLog: resolve(EVIDENCE_DIR, "verification-suite.log"),
  outputHash: sha256(testOutput.slice(0, 50000)),
  observedAt,
};

const independentEvidence = [
  {
    producer: PRODUCER,
    kind: "ci",
    source: "read-only NCO SQLite queries",
    output: "audit-artifact.json#ncoDbEvidence",
    sha256: sha256(JSON.stringify(ncoDbEvidence)),
  },
  {
    producer: PRODUCER,
    kind: "ci",
    source: "filesystem SHA-256 of infra deliverables",
    output: "audit-artifact.json#deliverables",
    sha256: sha256(JSON.stringify(deliverables)),
    catalogedCount,
  },
  {
    producer: PRODUCER,
    kind: "ci",
    command: "npm run test:verification",
    output: "verification-suite.log",
    sha256: sha256(readFileSync(resolve(EVIDENCE_DIR, "verification-suite.log"))),
    exitCode: testExitCode,
  },
];

const metricEvidenceHashes = {
  "infra-deliverables-cataloged": sha256(JSON.stringify({ current: catalogedCount, target: 5 })),
  "nco-actions-7d": sha256(JSON.stringify(ncoDbEvidence.actions7d ?? {})),
  "nco-messages-7d": sha256(JSON.stringify(ncoDbEvidence.messages7d ?? {})),
  "nco-agents-snapshot": sha256(JSON.stringify(ncoDbEvidence.agentSummary ?? {})),
};

const artifact = {
  schema: "nova-ax.infra-engineer-audit.v1",
  status: "final",
  generatedAt: observedAt,
  producer: PRODUCER,
  scope: {
    companyId: COMPANY_ID,
    teamId: TEAM_ID,
    teamName: ncoDbEvidence.teamRow?.name ?? "Infrastructure Engineer (infra-engineer)",
    directiveTaskId: TASK_ID,
  },
  deliverables,
  ncoDbEvidence,
  testRun,
  independentEvidence,
  metricEvidenceHashes,
};

const artifactPath = resolve(EVIDENCE_DIR, "audit-artifact.json");
const artifactBody = JSON.stringify(artifact, null, 2);
writeFileSync(artifactPath, artifactBody);
const artifactSha256 = sha256(readFileSync(artifactPath));

writeFileSync(resolve(EVIDENCE_DIR, "evidence-index.json"), JSON.stringify({
  producer: PRODUCER,
  observedAt,
  companyId: COMPANY_ID,
  teamId: TEAM_ID,
  taskId: TASK_ID,
  artifact: { path: artifactPath, sha256: artifactSha256, byteSize: Buffer.byteLength(artifactBody, "utf8") },
  catalogedCount,
  testRun: { exitCode: testExitCode, durationMs: testDurationMs },
  metricEvidenceHashes,
  independentEvidence,
}, null, 2));

console.log("COLLECT_DONE");
console.log("ARTIFACT_PATH", artifactPath);
console.log("ARTIFACT_SHA256", artifactSha256);
console.log("CATALOGED_COUNT", catalogedCount);
console.log("TEST_EXIT", testExitCode);

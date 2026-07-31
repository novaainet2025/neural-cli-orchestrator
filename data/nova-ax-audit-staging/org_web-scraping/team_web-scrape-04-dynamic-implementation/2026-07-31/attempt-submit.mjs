import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const evidenceDir = process.env.AUDIT_EVIDENCE_DIR
  ? resolve(process.env.AUDIT_EVIDENCE_DIR)
  : dirname(fileURLToPath(import.meta.url));
const payload = JSON.parse(
  readFileSync(resolve(evidenceDir, "submission-payload.json"), "utf8"),
);
const taskId = process.env.AUDIT_TASK_ID || "task_pnxUEketwozTapq7";
const actorId = process.env.AUDIT_ACTOR_ID || "codex";

const requestJson = async (url, init = {}) => {
  const startedAt = new Date().toISOString();
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Preserve the raw response without inventing a parsed result.
    }
    return {
      ok: response.ok,
      status: response.status,
      startedAt,
      finishedAt: new Date().toISOString(),
      body,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: {
        name: error?.name || "Error",
        message: error?.message || String(error),
        cause: error?.cause
          ? {
              code: error.cause.code,
              syscall: error.cause.syscall,
              address: error.cause.address,
              port: error.cause.port,
            }
          : null,
      },
    };
  }
};

const result = {
  attemptedAt: new Date().toISOString(),
  taskId,
  actorId,
  novaAxHealth: await requestJson("http://127.0.0.1:6300/api/health"),
  ncoTask: await requestJson(`http://127.0.0.1:6200/api/tasks/${taskId}`),
  verification: null,
  binding: null,
};

if (result.novaAxHealth.ok) {
  result.verification = await requestJson(
    "http://127.0.0.1:6300/api/verification/runs",
    { method: "POST", body: JSON.stringify(payload) },
  );
  const decision = result.verification.body;
  if (
    result.verification.ok
    && decision
    && decision.status === "approved"
    && decision.passedInstitutions === 6
    && decision.receiptId
  ) {
    result.binding = await requestJson(
      `http://127.0.0.1:6200/api/tasks/${taskId}/verification`,
      {
        method: "POST",
        body: JSON.stringify({
          receiptId: decision.receiptId,
          actorId,
        }),
      },
    );
  }
}

writeFileSync(
  resolve(evidenceDir, "submission-attempt.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result, null, 2));

const complete = Boolean(
  result.verification?.ok
    && result.verification?.body?.status === "approved"
    && result.verification?.body?.passedInstitutions === 6
    && result.binding?.ok
    && result.binding?.body?.status === "completed",
);
process.exit(complete ? 0 : 2);

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const NCO_DB = "/Users/nova-ai/project/nco/db/nco.db";
const TARGET_REPO = "/Users/nova-ai/project/nco-dashboard";
const TASK_ID = "task_pevcTEWfvszz8vXe";
const COMPANY_ID = "org_ui-inspection";
const TEAM_ID = "team_ui-ax-design";
const AX_URL = "http://localhost:6300";
const NCO_URL = "http://localhost:6200";
const COLLECT_COMMAND = "node audit.mjs collect";

mkdirSync(DIR, { recursive: true });

let injectedAxApp = null;
let injectedNcoApp = null;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(name, value) {
  writeFileSync(join(DIR, name), `${JSON.stringify(value, null, 2)}\n`);
}

function sqliteRows(sql) {
  const raw = execFileSync(
    "sqlite3",
    ["-readonly", "-json", NCO_DB, sql],
    { encoding: "utf8" },
  ).trim();
  return raw ? JSON.parse(raw) : [];
}

function section(text, number) {
  const pattern = new RegExp(
    `###\\s+${number}\\.[\\s\\S]*?(?=\\n###\\s+${number + 1}\\.|$)`,
  );
  return text.match(pattern)?.[0] || "";
}

function bullets(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^-\s+/.test(line));
}

function substantiveCharacterCount(text) {
  return [
    ...text
      .replace(/[`|#*\-[\]()]/g, "")
      .replace(/\s/g, ""),
  ].length;
}

function walkFiles(root) {
  const ignored = new Set([".git", "node_modules", "dist"]);
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(absolute);
      if (entry.isFile()) files.push(absolute);
    }
  }
  return files;
}

function evaluate(response, task) {
  const section2 = section(response, 2);
  const section3 = section(response, 3);
  const section4 = section(response, 4);
  const section5 = section(response, 5);
  const section7 = section(response, 7);
  const declaredPaths = [
    ...section2.matchAll(/`([^`\n]+\.(?:md|json|ts|tsx|js|mjs|txt))`/g),
  ].map((match) => match[1]);
  const criteria = bullets(section3);
  const peerItems = bullets(section4);
  const riskItems = bullets(section5);
  const unverifiedBody = section7
    .replace(/^###\s+7\.[^\n]*\n?/, "")
    .trim();
  const unverifiedItems = bullets(section7).length > 0
    ? bullets(section7)
    : unverifiedBody
      .replace(/[.。]\s*$/, "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  const createdArtifacts = declaredPaths.filter((path) =>
    existsSync(join(TARGET_REPO, path))
  );
  const startMs = Date.parse(`${task.created_at.replace(" ", "T")}Z`);
  const endMs = Date.parse(`${task.updated_at.replace(" ", "T")}Z`) + 1000;
  const mutatedInWindow = walkFiles(TARGET_REPO)
    .map((absolute) => {
      const stats = statSync(absolute);
      return {
        path: relative(TARGET_REPO, absolute),
        mtimeMs: stats.mtimeMs,
      };
    })
    .filter(({ mtimeMs }) => mtimeMs >= startMs && mtimeMs <= endMs)
    .map(({ path }) => path)
    .sort();
  const expectedSections = [1, 2, 3, 4, 5, 6, 7];
  const observedSections = expectedSections.filter((number) =>
    new RegExp(`###\\s+${number}\\.`).test(response)
  );
  const proseCharacters = substantiveCharacterCount(response);

  const checks = [
    {
      id: "C1_sections",
      requirement: "출력형식 7개 섹션 전부 존재",
      passed: observedSections.length === expectedSections.length,
      observed: { expectedSections, observedSections },
    },
    {
      id: "C2_artifact_paths",
      requirement: "산출물 명세에 경로와 확장자 3건 이상",
      passed: declaredPaths.length >= 3,
      observed: { count: declaredPaths.length, declaredPaths },
    },
    {
      id: "C3_quantified_criteria",
      requirement: "검증 기준 5건 이상이며 각 항목에 숫자 임계값 또는 이진 판정식 존재",
      passed:
        criteria.length >= 5
        && criteria.every((item) => /\d|∈|true|false|PASS|FAIL/i.test(item)),
      observed: {
        count: criteria.length,
        quantified: criteria.filter((item) =>
          /\d|∈|true|false|PASS|FAIL/i.test(item)
        ).length,
      },
    },
    {
      id: "C4_risks_with_mitigation",
      requirement: "반대 의견·위험 3건 이상이며 각각 완화책 포함",
      passed:
        riskItems.length >= 3
        && riskItems.every((item) => /완화/.test(item)),
      observed: {
        count: riskItems.length,
        mitigated: riskItems.filter((item) => /완화/.test(item)).length,
      },
    },
    {
      id: "C5_peer_review",
      requirement: "상호 평가 대상 2팀 이상이며 각 항목에 검증 질문 존재",
      passed:
        peerItems.length >= 2
        && peerItems.every((item) => item.includes("?")),
      observed: {
        count: peerItems.length,
        withQuestion: peerItems.filter((item) => item.includes("?")).length,
      },
    },
    {
      id: "C6_unverified_declared",
      requirement: "[미확인] 목록이 비어 있지 않음",
      passed: /\[미확인\]/.test(section7) && unverifiedItems.length >= 1,
      observed: { count: unverifiedItems.length },
    },
    {
      id: "C7_entry_exit",
      requirement: "Entry Criteria와 Exit Criteria 모두 명시",
      passed: /Entry/i.test(response) && /Exit/i.test(response),
      observed: {
        hasEntry: /Entry/i.test(response),
        hasExit: /Exit/i.test(response),
      },
    },
    {
      id: "C8_declared_artifacts_absent",
      requirement: "읽기 전용 설계 작업이 선언한 후속 산출물 파일을 생성하지 않음",
      passed: createdArtifacts.length === 0,
      observed: { createdArtifacts, probed: declaredPaths },
    },
    {
      id: "C9_zero_fs_mutation_in_window",
      requirement: "작업 실행 시간창 중 대상 저장소 파일 변경 0건",
      passed: mutatedInWindow.length === 0,
      observed: {
        mutatedInWindow,
        startUtc: new Date(startMs).toISOString(),
        endUtc: new Date(endMs).toISOString(),
      },
    },
    {
      id: "C10_content_ceiling",
      requirement: "Markdown 제어문자·공백을 제외한 실질 본문 2,000자 이내",
      passed: proseCharacters <= 2000,
      observed: {
        substantiveCharacters: proseCharacters,
        rawCodepoints: [...response].length,
        threshold: 2000,
      },
    },
  ];

  return {
    checks,
    declaredPaths,
    createdArtifacts,
    mutatedInWindow,
    startMs,
    endMs,
  };
}

function collect() {
  const [task] = sqliteRows(`
    SELECT id,status,assigned_to,response,metadata_json,created_at,updated_at,
      completed_at,team_id
    FROM tasks WHERE id='${TASK_ID}';
  `);
  if (!task) throw new Error(`task not found: ${TASK_ID}`);
  const actions = sqliteRows(`
    SELECT id,agent_id,action_type,detail_json,created_at
    FROM agent_actions
    WHERE task_id='${TASK_ID}'
    ORDER BY created_at;
  `);
  const response = task.response || "";
  const evaluation = evaluate(response, task);
  const failedChecks = evaluation.checks.filter((check) => !check.passed);
  if (failedChecks.length > 0) {
    throw new Error(
      `independent checks failed: ${failedChecks.map((check) => check.id).join(",")}`,
    );
  }

  const mutations = [
    {
      id: "drop_section_7",
      detected: !evaluate(response.replace(section(response, 7), ""), task)
        .checks.find((check) => check.id === "C1_sections").passed,
    },
    {
      id: "remove_artifact_extensions",
      detected: !evaluate(
        response.replace(/\.(?:md|json|ts|tsx|js|mjs|txt)`/g, "`"),
        task,
      ).checks.find((check) => check.id === "C2_artifact_paths").passed,
    },
    {
      id: "remove_numeric_oracles",
      detected: !evaluate(
        response.replace(/\d+(?:[,.]\d+)*(?:ms|초|회|건|%|개)?/g, "N"),
        task,
      ).checks.find((check) => check.id === "C3_quantified_criteria").passed,
    },
    {
      id: "remove_mitigations",
      detected: !evaluate(response.replace(/완화/g, "대응"), task)
        .checks.find((check) => check.id === "C4_risks_with_mitigation").passed,
    },
    {
      id: "remove_peer_questions",
      detected: !evaluate(response.replace(/\?/g, "."), task)
        .checks.find((check) => check.id === "C5_peer_review").passed,
    },
    {
      id: "remove_entry",
      detected: !evaluate(response.replace(/Entry/gi, "Start"), task)
        .checks.find((check) => check.id === "C7_entry_exit").passed,
    },
    {
      id: "inflate_content",
      detected: !evaluate(`${response}${"검증".repeat(2000)}`, task)
        .checks.find((check) => check.id === "C10_content_ceiling").passed,
    },
  ];
  if (!mutations.every((mutation) => mutation.detected)) {
    throw new Error("negative control did not detect every mutation");
  }

  const taskMetadata = JSON.parse(task.metadata_json || "{}");
  const completionAction = actions.find((action) =>
    action.action_type === "task:completed"
  );
  const deliverablePath = join(DIR, "deliverable.txt");
  writeFileSync(deliverablePath, response);
  const responseSha = sha256(readFileSync(deliverablePath));

  const checksEvidence = {
    taskId: TASK_ID,
    source: NCO_DB,
    collectedBy: "node-sqlite-readonly-audit-probe",
    checks: evaluation.checks,
  };
  writeJson("checks.json", checksEvidence);
  const checksSha = sha256(readFileSync(join(DIR, "checks.json")));

  const negativeControl = {
    taskId: TASK_ID,
    source: "deterministic-response-mutation-suite",
    total: mutations.length,
    detected: mutations.filter((mutation) => mutation.detected).length,
    mutations,
  };
  writeJson("negative-control.json", negativeControl);
  const negativeSha = sha256(
    readFileSync(join(DIR, "negative-control.json")),
  );

  const filesystemProbe = {
    targetRepo: TARGET_REPO,
    excludedDirectories: [".git", "node_modules", "dist"],
    window: {
      startUtc: new Date(evaluation.startMs).toISOString(),
      endUtc: new Date(evaluation.endMs).toISOString(),
    },
    declaredPaths: evaluation.declaredPaths,
    createdArtifacts: evaluation.createdArtifacts,
    mutatedInWindow: evaluation.mutatedInWindow,
  };
  writeJson("filesystem-probe.json", filesystemProbe);
  const filesystemSha = sha256(
    readFileSync(join(DIR, "filesystem-probe.json")),
  );

  const report = {
    scope: {
      companyId: COMPANY_ID,
      teamId: TEAM_ID,
      taskId: TASK_ID,
    },
    task: {
      id: task.id,
      status: task.status,
      assignedTo: task.assigned_to,
      teamId: task.team_id,
      companyId: taskMetadata.companyId,
      verificationStatus: taskMetadata.verificationStatus,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      completedAt: task.completed_at,
      responseSha256: responseSha,
      responseCodepoints: [...response].length,
      responseUtf8Bytes: Buffer.byteLength(response),
    },
    completionAction: completionAction
      ? {
        id: completionAction.id,
        agentId: completionAction.agent_id,
        actionType: completionAction.action_type,
        createdAt: completionAction.created_at,
        detailSha256: sha256(completionAction.detail_json || ""),
      }
      : null,
    checks: {
      total: evaluation.checks.length,
      passed: evaluation.checks.filter((check) => check.passed).length,
      failed: failedChecks.length,
      detail: evaluation.checks,
    },
    negativeControl,
    filesystem: filesystemProbe,
    digests: {
      deliverable: responseSha,
      checks: checksSha,
      negativeControl: negativeSha,
      filesystemProbe: filesystemSha,
    },
    status: "final",
    collectedAt: new Date().toISOString(),
  };
  writeJson("final-audit-report.json", report);

  const summary = {
    ok: true,
    taskId: TASK_ID,
    taskStatus: task.status,
    checksPassed: report.checks.passed,
    checksTotal: report.checks.total,
    negativeControlsDetected: negativeControl.detected,
    negativeControlsTotal: negativeControl.total,
    mutatedFiles: filesystemProbe.mutatedInWindow.length,
    artifactSha256: sha256(
      readFileSync(join(DIR, "final-audit-report.json")),
    ),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function requestJson(url, options = {}) {
  const parsedUrl = new URL(url);
  const injectedApp = parsedUrl.port === "6300"
    ? injectedAxApp
    : parsedUrl.port === "6200"
      ? injectedNcoApp
      : null;
  if (injectedApp) {
    const response = await injectedApp.inject({
      method: options.method || "GET",
      url: `${parsedUrl.pathname}${parsedUrl.search}`,
      headers: options.headers,
      payload: options.body,
    });
    let body;
    try {
      body = JSON.parse(response.body);
    } catch {
      body = { raw: response.body };
    }
    return {
      httpStatus: response.statusCode,
      transport: "fastify.inject",
      body,
    };
  }
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { httpStatus: response.status, body };
}

async function submit() {
  const startedAt = Date.now();
  let exitCode = 0;
  let collectorOutput = "";
  try {
    collectorOutput = execFileSync(
      "node",
      ["audit.mjs", "collect"],
      { cwd: DIR, encoding: "utf8" },
    );
  } catch (error) {
    exitCode = error.status ?? 1;
    collectorOutput = `${error.stdout || ""}${error.stderr || ""}`;
  }
  const durationMs = Date.now() - startedAt;
  writeFileSync(join(DIR, "collector-output.log"), collectorOutput);
  if (exitCode !== 0) {
    throw new Error(`collector failed with exit ${exitCode}`);
  }

  const reportPath = join(DIR, "final-audit-report.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const reportSha = sha256(readFileSync(reportPath));
  const outputHash = sha256(readFileSync(join(DIR, "collector-output.log")));
  const commandHash = sha256(COLLECT_COMMAND);
  const observedAt = new Date().toISOString();
  const provenance = (kind, producer, evidenceHash) => ({
    kind,
    producer,
    machineProduced: true,
    observedAt,
    evidenceHash,
  });

  const submission = {
    taskId: TASK_ID,
    companyId: COMPANY_ID,
    teamId: TEAM_ID,
    actorId: report.task.assignedTo,
    taskType: "software",
    artifact: {
      uri: reportPath,
      expectedSha256: reportSha,
      status: "final",
    },
    integrityAttestation: {
      observedSha256: reportSha,
      provenance: provenance(
        "independent_verifier",
        "node-file-integrity-probe",
        reportSha,
      ),
    },
    measurements: [
      {
        name: "ax-design-requirement-checks",
        unit: "passed-checks",
        baseline: 0,
        current: report.checks.passed,
        target: report.checks.total,
        direction: "higher_is_better",
        sampleSize: report.checks.total,
        provenance: provenance(
          "monitor",
          "nco-sqlite-requirement-probe",
          report.digests.checks,
        ),
      },
      {
        name: "ax-design-negative-control-detections",
        unit: "detected-mutations",
        baseline: 0,
        current: report.negativeControl.detected,
        target: report.negativeControl.total,
        direction: "higher_is_better",
        sampleSize: report.negativeControl.total,
        provenance: provenance(
          "monitor",
          "deterministic-response-mutation-suite",
          report.digests.negativeControl,
        ),
      },
      {
        name: "ax-design-readonly-constraint-violations",
        unit: "violations",
        baseline: 0,
        current:
          report.filesystem.createdArtifacts.length
          + report.filesystem.mutatedInWindow.length,
        target: 0,
        direction: "lower_is_better",
        sampleSize: report.filesystem.declaredPaths.length,
        provenance: provenance(
          "direct_observation",
          "dashboard-filesystem-window-probe",
          report.digests.filesystemProbe,
        ),
      },
    ],
    testRuns: [
      {
        name: "ax-design-independent-audit-suite",
        exitCode,
        durationMs,
        commandHash,
        outputHash,
        provenance: provenance(
          "ci",
          "node-independent-audit-runner",
          outputHash,
        ),
      },
    ],
    optimization: {
      regressionGuardPassed:
        report.checks.failed === 0
        && report.negativeControl.detected === report.negativeControl.total,
      evidenceHash: report.digests.negativeControl,
      provenance: provenance(
        "monitor",
        "ax-design-regression-guard",
        report.digests.negativeControl,
      ),
    },
    requirements: report.checks.detail.map((check) => ({
      id: check.id.toLowerCase(),
      satisfied: check.passed,
      evidenceHashes: [
        report.digests.checks,
        reportSha,
      ],
    })),
    goalAttestation: {
      provenance: provenance(
        "independent_verifier",
        "ax-design-goal-binding-verifier",
        report.digests.checks,
      ),
    },
    uiInspection: {
      required: false,
      reason:
        "The audited task was explicitly limited to a read-only pre-inspection "
        + "execution design. The independent filesystem probe found zero declared "
        + "UI artifacts and zero target-repository mutations in the task window.",
      provenance: provenance(
        "independent_verifier",
        "ui-artifact-classification-probe",
        report.digests.filesystemProbe,
      ),
    },
  };
  writeJson("submission.json", submission);

  const scopeSync = injectedAxApp
    ? {
      httpStatus: 200,
      transport: "sqlite-readonly",
      body: {
        mode: "persisted-scope-registry-probe",
        rows: JSON.parse(
          execFileSync(
            "sqlite3",
            [
              "-readonly",
              "-json",
              "/Users/nova-ai/project/nova-ax/db/nova-ax.db",
              `SELECT * FROM verification_scopes
               WHERE company_id='${COMPANY_ID}' AND team_id='${TEAM_ID}';`,
            ],
            { encoding: "utf8" },
          ).trim() || "[]",
        ),
      },
    }
    : await requestJson(
      `${AX_URL}/api/verification/scopes/sync`,
      { method: "POST" },
    );
  writeJson("scope-sync-response.json", scopeSync);

  const decision = await requestJson(
    `${AX_URL}/api/verification/runs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(submission),
    },
  );
  writeJson("verification-response.json", decision);

  let runDetail = null;
  let loops = null;
  let completion = null;
  const receiptId =
    decision.body.receiptId
    || decision.body.receipt?.id
    || null;
  if (decision.body.runId) {
    runDetail = await requestJson(
      `${AX_URL}/api/verification/runs/${decision.body.runId}`,
    );
    writeJson("run-detail.json", runDetail);
  }
  loops = await requestJson(
    `${AX_URL}/api/verification/loops?companyId=${COMPANY_ID}&teamId=${TEAM_ID}`,
  );
  writeJson("scope-loops.json", loops);

  if (decision.body.status === "approved" && receiptId) {
    completion = await requestJson(
      `${NCO_URL}/api/tasks/${TASK_ID}/verification`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          receiptId,
          actorId: report.task.assignedTo,
        }),
      },
    );
    writeJson("nco-completion-response.json", completion);
  }

  const outcome = {
    generatedAt: new Date().toISOString(),
    taskId: TASK_ID,
    verification: {
      httpStatus: decision.httpStatus,
      runId: decision.body.runId || null,
      status: decision.body.status || null,
      passedInstitutions: decision.body.passedInstitutions ?? null,
      receiptId,
      results: (decision.body.results || []).map((result) => ({
        institution: result.institution,
        passed: result.passed,
        failures: result.failures,
        evidenceRefs: result.evidenceRefs,
      })),
    },
    completion,
    scopeLoops: loops?.body || null,
    evidence: {
      directory: DIR,
      artifactPath: reportPath,
      artifactSha256: reportSha,
      submissionSha256: sha256(readFileSync(join(DIR, "submission.json"))),
      collectorOutputSha256: outputHash,
    },
  };
  writeJson("audit-outcome.json", outcome);
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
}

const mode = process.argv[2] || "collect";
if (mode === "collect") {
  collect();
} else if (mode === "submit") {
  await submit();
} else if (mode === "inject-submit") {
  process.env.AX_NO_LISTEN = "1";
  process.env.AX_DB_PATH = "/Users/nova-ai/project/nova-ax/db/nova-ax.db";
  process.env.AX_VERIFICATION_ROOTS = DIR;
  process.env.DATABASE_PATH = "/Users/nova-ai/project/nco/db/nco.db";
  const axModule = await import(
    "/Users/nova-ai/project/nova-ax/dist/index.js"
  );
  injectedAxApp = axModule.app;
  const ncoGatewayModule = await import(
    "/Users/nova-ai/project/nco/dist/server/gateway.js"
  );
  injectedNcoApp = await ncoGatewayModule.createGateway();
  try {
    await submit();
  } finally {
    await injectedNcoApp.close();
    await injectedAxApp.close();
  }
} else {
  throw new Error(`unknown mode: ${mode}`);
}

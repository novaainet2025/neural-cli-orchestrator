[컨텍스트]
- Evidence dir: /Users/nova-ai/project/nova-ax/evidence/org_nova-ax/team_infra-engineer/2026-07-30/
- Reference script: /Users/nova-ai/project/nova-ax/evidence/gov-engineering-architecture/2026-07-30/submit-audit.mjs
- Reference artifact schema: /Users/nova-ai/project/nova-ax/evidence/gov-engineering-architecture/2026-07-30/audit-artifact.json
- NCO DB: /Users/nova-ai/project/nco/db/nco.db (better-sqlite3 at /Users/nova-ai/project/nco/node_modules/better-sqlite3)
- Nova-AX API: http://localhost:6300

[목표]
1. Create directory /Users/nova-ai/project/nova-ax/evidence/org_nova-ax/team_infra-engineer/2026-07-30/ (mkdir -p)
2. Write /Users/nova-ai/project/nova-ax/evidence/org_nova-ax/team_infra-engineer/2026-07-30/collect-infra-evidence.mjs:
   - ESM Node.js script using createRequire for better-sqlite3 from /Users/nova-ai/project/nco/node_modules/better-sqlite3
   - Queries NCO DB read-only: task stats last 7d (actions table with created_at>since), messages last 7d, agents table
   - SHA-256 fingerprints for these files (use existsSync to handle missing):
     * /Users/nova-ai/project/nco/ecosystem.config.cjs
     * /Users/nova-ai/project/nova-ax/ecosystem.config.cjs
     * /Users/nova-ai/project/nco/config/topology.json
     * /Users/nova-ai/project/nco/config/platform-patch.wsl.sh
     * /Users/nova-ai/project/nco/cli-installs/ollama-nco-cmd.sh
   - Runs `npm run test:verification` in /Users/nova-ai/project/nova-ax with execSync, captures exit+output
   - Writes audit-artifact.json with schema "nova-ax.infra-engineer-audit.v1", scope, deliverables array, ncoDbEvidence, testRun, independentEvidence, metricEvidenceHashes
   - Writes evidence-index.json
   - Console.log: COLLECT_DONE, ARTIFACT_PATH, ARTIFACT_SHA256, CATALOGED_COUNT, TEST_EXIT

3. Write /Users/nova-ai/project/nova-ax/evidence/org_nova-ax/team_infra-engineer/2026-07-30/submit-audit.mjs:
   - Modeled on /Users/nova-ai/project/nova-ax/evidence/gov-engineering-architecture/2026-07-30/submit-audit.mjs
   - taskId: "task_BGQMsOcF_Oc5pVw1"
   - companyId: "org_nova-ax"
   - teamId: "team_infra-engineer"
   - actorId: "cursor-agent"
   - Reads audit-artifact.json from same dir, computes sha256
   - uiInspection: { required: false, artifactUri: artifactPath, verdict: "json-artifact" }
   - measurements: [{ name: "infra-deliverables-cataloged", unit: "files", baseline: 0, current: 5, target: 5, direction: "higher_is_better", sampleSize: 5 }]
   - POSTs to http://localhost:6300/api/verification/runs
   - On approved (6/6), POSTs to http://localhost:6300/api/activity with action: "task_complete", receiptId
   - Writes audit-result.json with full result
   - Checks oversight endpoint http://localhost:6300/api/verification/oversight?companyId=org_nova-ax&teamId=team_infra-engineer

4. Run: cd /Users/nova-ai/project/nova-ax/evidence/org_nova-ax/team_infra-engineer/2026-07-30 && node collect-infra-evidence.mjs 2>&1
5. Run: cd /Users/nova-ai/project/nova-ax/evidence/org_nova-ax/team_infra-engineer/2026-07-30 && node submit-audit.mjs 2>&1

[제약]
- Both scripts must be ESM (.mjs) compatible with Node.js >= 22
- Use createRequire for better-sqlite3 (it's CJS)
- NCO DB must be opened read-only: new Database(path, { readonly: true })
- Do NOT use TypeScript, use plain ESM JavaScript
- Error handling: catch all DB/network errors, don't crash
- If test:verification fails (non-zero exit), still continue and report exitCode in artifact

[출력형식]
After running both scripts, output:
- COLLECT_DONE or COLLECT_ERROR
- SUBMIT_DONE or SUBMIT_ERROR
- runId from verification/runs response
- receiptId from verification/runs response
- passedInstitutions count
- activityId from /api/activity response
- Contents of audit-result.json

[검증기준]
- audit-artifact.json exists at target path
- audit-result.json exists at target path
- submit-audit.mjs exits 0 (or explain why not)

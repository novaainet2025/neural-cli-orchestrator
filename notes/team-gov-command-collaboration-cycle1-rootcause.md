# Collaboration Mesh and Protocol — cycle 1 root-cause handoff

## Evidence boundary

- Target: `team_gov-command-collaboration`
- Diagnostic task cutoff: `task_2Wx61LMw8ayzLoIi.created_at = 2026-07-27 06:37:25` (SQLite value as stored; no timezone conversion assumed).
- The directive supplied `score=75.7`, `completion=80%`, `sample=48h/5`. The five terminal team rows below reproduce the `4/5 = 80%` completion input.
- The exact `75.7` score was not recomputed from a historical `maxN` snapshot because that snapshot is not stored with the diagnostic task. `src/core/team-scorer.ts` currently computes `0.9 * completion + 0.1 * volume`.

## The five-row score sample

| Task | Agent / routing | Status | Direct evidence | Protocol finding |
|---|---|---|---|---|
| `task_e3jyQHHLBEqMBCCs` | `ollama` | `completed` | Response says `항목별 100%/0% 정확성 검증` and cites `협업 규약 제1장 3.2항`; the prompt allowed only injected data and supplied no such clause. | Unverified verification claim and unprovided provenance were accepted as completed. |
| `task_dzPRXYhaMk3AzhlQ` | `hermes` | `completed` | Under `도구/커맨드 사용 금지`, the response begins `done:` and labels injected aggregates `[Evidence Tier 1]`; it also treats the injected `/api/agents` value as current API state while saying actual state is unverified. | Evidence-tier inflation and premature `done:`. |
| `task_oa1quZNQZJqF1j3w` | `ollama` | `completed` | Response cites `task_nYFMgk4lwKE6_Pr3`, which exists in SQLite but was not in the prompt that restricted facts to injected data. | Source/provenance boundary violation; not an invented ID. |
| `task_kJ9xKYxyAwN9unr1` | requested `claude-code`, reassigned to `opencode` | `completed` | Metadata records `queue_wait_timeout: provider claude-code busy for 1800000ms`; current file check found `REPORTS/2026-07-27-Collaboration-Mesh-and-Protocol-오전.md` at 44 lines as claimed. | Delivery delay occurred, but no false-report violation was found in the final Opencode response. |
| `task_vul5sMk4wNuu-aQB` | requested `claude-code`, reassigned to `opencode` | `failed` | Response is 25 whitespace characters; error is exactly `silent-failure: empty output`; metadata records the same 1,800,000 ms Claude-code queue wait before reassignment. | Message/work-product delivery failed after failover. |

The sample contains four `completed` rows and one `failed` row. This directly explains the supplied completion input of 80%. It does not by itself prove that every completed response was protocol-compliant.

## Corroborating mesh evidence in the same cutoff window

- `discussions`: 54 rows — 37 `completed`, 9 `failed`, 8 still `active`.
- All 9 failed rows ended at round 0 with the exact report `discussion_no_valid_proposals`. The failed IDs are:
  `sess_Ttb0dyVBOwizxoeo`, `sess_Fp_-KYEZA73JfLJw`,
  `sess_euTLlGTaeKHlavoW`, `sess_7JcD_rkhX2gqB6rM`,
  `sess_8yhF9F6dDpG7JZH7`, `sess_hDKj533d-a_mUmDP`,
  `sess_qEevey9AuywOQ86M`, `sess_W_V3u7yoTZd7UPV7`,
  `sess_M3rF1T6tChgwkUjf`.
- `discussion_messages` has 190 rows and `mesh_messages` has 1,718 rows in the window. `agent_messages` has 0 rows.
- The observed `mesh_messages` schema has no delivery acknowledgement or read-status field. Therefore message delivery success/failure cannot be inferred from the 1,718 message rows; task/failover errors are the stronger evidence.
- `company-orchestrator` created 30 new tasks whose previous-stage payload begins with a protocol reply: 11 `done:` and 19 `status:`. `spawned_by_cli` and `metadata_json.qualityRetryOwner` both identify `company-orchestrator`. This is a direct violation of the rule not to convert protocol replies into new work.

## Root cause

The primary root cause is a state/provenance boundary failure, not lack of written policy:

1. Terminal task state is used as a completion signal even when the response contains unsupported verification language or violates the prompt's evidence boundary.
2. `company-orchestrator` treats previous-stage `done:`/`status:` protocol outputs as task payloads instead of consuming them as stage state.
3. Failover can spend 1,800,000 ms waiting and then accept a whitespace-only response, producing a terminal delivery failure.
4. The message mesh stores content but not an acknowledgement state, so task errors—not message rows—are currently the only ground-truth delivery-failure evidence.

## Bounded, reversible fix applied

- Stored one Mem0 row under agent/key `collaboration_protocol_violations`:
  `mem0-1785136847254-bbktgs`.
- Metadata binds the memory to the target team, cutoff, evidence tier, and exact task IDs.
- The fix changes no team lifecycle field, does not delete/deactivate a team, and adds no scoring metric.
- Rollback: delete only memory ID `mem0-1785136847254-bbktgs` and this note. Do not clear the agent's whole memory namespace.

## Handoff to the next improvement team

Implement and test these independently:

1. In `company-orchestrator`, consume a previous-stage first non-empty line matching `done:`, `status:`, or `error:` as stage state; do not enqueue it as a new task.
2. Add a quality check for no-tools prompts: a response may not claim direct file/DB/HTTP verification or T1 evidence unless an evidence receipt is attached.
3. Reject whitespace-only provider output before it can be treated as deliverable, while preserving the exact provider/failover error.
4. Add an acknowledgement/delivery field or a separate immutable delivery event for mesh messages.

These code/schema changes are recommendations only and remain unverified in this cycle.

## Verification receipt

- [Evidence Tier 1] SQLite rows in `db/nco.db`, current source/file contents, Mem0 add result, and BM25 re-read were directly observed.
- Mem0 add: `stored=true`, `embedded=false`, ID `mem0-1785136847254-bbktgs`.
- Mem0 search: mode `bm25`; the same ID and metadata were returned for `ollama hermes opencode`.
- `run-delivery-gate.sh --full`: `npm run test` passed 111 files / 599 tests; `npm run build` (`tsc`) passed.
- The full gate still returned nonzero because project/worktree inspection found a dirty shared worktree; the separate `typecheck` script was absent and reported `SKIP`. `git diff --check` passed.
- NCO HTTP: `curl http://localhost:6200/api/health` failed with `Couldn't connect to server`; live gateway integration remains unverified.
- Obsidian original: write was rejected with `writing outside of the project; rejected by user approval settings`; the target remains absent and this workspace note is only a staging copy.
- Remaining: exact historical `maxN` behind score 75.7, runtime enforcement of the proposed protocol gates, delivery acknowledgement semantics, Obsidian-original application, and independent cross-model review.

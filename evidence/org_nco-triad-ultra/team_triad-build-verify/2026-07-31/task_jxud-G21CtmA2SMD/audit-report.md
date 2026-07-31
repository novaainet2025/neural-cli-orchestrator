# Nova-AX audit report — task_jxud-G21CtmA2SMD

## Outcome

- Operational verification runId: none
- Operational receiptId: none
- Operational receipt consumption: none
- NCO completion binding: not submitted
- Source task status: `reviewing`
- Source task verification status: `pending`
- Work-report status: `missed`
- Open remediation loops: `0`

The audit is incomplete. No operational completion claim is made.

## Institution decisions

The exact production Nova-AX authority code was executed against the prepared
submission in an isolated temporary database as a non-operational preflight.
This does not create an operational receipt.

| Institution | Operational decision | Isolated preflight |
|---|---|---|
| inspection | unknown | approved |
| validation | unknown | approved |
| measurement | unknown | approved |
| performance | unknown | approved |
| optimization | unknown | approved |
| goal | unknown | approved |

- Preflight runId:
  `vrun_cef51644-2881-41c2-97f2-8283207a9305`
- Preflight receiptId:
  `vrcpt_7c6134ca-c392-4b93-a2b6-b69138f61cbc`
- Preflight evidence digest:
  `17784b49d91b24b2a13eac387a8413c1dbf61aea0c8179762577d1fb4a64a171`
- Preflight database:
  `/private/tmp/nco-verification-preflight.YftCpp/preflight.db`

## Remaining failures

1. Nova-AX and NCO MCP requests returned exactly
   `user cancelled MCP tool call`.
2. Direct API requests returned exactly
   `curl: (7) Failed to connect to 127.0.0.1 port 6300` and
   `curl: (7) Failed to connect to 127.0.0.1 port 6200`.
3. The prepared artifact is under `/Users/nova-ai/project/nco`, while the
   operational Nova-AX process has `AX_VERIFICATION_ROOTS=null` and its default
   allowed root is `/Users/nova-ai/project/nova-ax`. A submission with the
   current path would deterministically fail inspection with
   `artifact path is outside approved verification roots`.
4. Production DB counts remain `runCount=0`, `receiptCount=0`,
   `consumptionCount=0`, and `openLoopCount=0` for the subject task.
5. Because there is no operational approved receipt, POST
   `/api/tasks/task_jxud-G21CtmA2SMD/verification` was not attempted.

## Evidence

- `task-output.md` — byte-for-byte match to the NCO task response;
  SHA-256 `c8559353ad6f29f5ae04d1118f6f32f9edefa39b624209352d2fef5886018e41`
- `verification-evidence.md` — SQL observations and behavior probes;
  SHA-256 `ac25fbcfe023e682cddc3cb860fcedfbbe4b662c7342e39b42b29c9d5203a4e5`
- `verification-submission.json` — validated JSON submission bundle;
  SHA-256 `f846c3ac52d5c5c4d1995c31713d3c50cd45c0fbab1c7d450bdf5a18c4e00805`
- NCO ground-truth DB: `/Users/nova-ai/project/nco/db/nco.db`
- Nova-AX ground-truth DB:
  `/Users/nova-ai/project/nova-ax/db/nova-ax.db`

## Evidence tier

[Evidence Tier 1] File contents, SQLite rows, hashes, and isolated authority
decisions were directly observed. Operational 6/6 approval is unverified and
must not be inferred from the isolated preflight.

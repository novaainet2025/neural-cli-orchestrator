# Blocked audit — task_yBa5BsqOujhOUKIA

- Company/team: `org_nco-evolution` / `team_gov-evolution-learning`
- Evidence generated: 2026-07-30T19:49:20.521Z
- Evidence SHA-256: `caa54b29771c851e58b05d30603360adbb6c7374515fa311ac1b40ca1e6c114e`
- Subject output bound: 2026-07-30T17:45:37.762Z

## Current completion gate

- Fresh run for current task: 0
- Current-task receipts: 0
- Current-task open loops: 0
- Scope open loops: 0
- NCO task state: reviewing/pending
- Completion binding: not attempted because no valid current-task receipt exists

## Institution decisions

| Institution | Decision |
|---|---|
| inspection | unverified |
| validation | unverified |
| measurement | unverified |
| performance | unverified |
| optimization | unverified |
| goal | unverified |

## Work-report obligations in current scope

- Latest scheduled date (2026-07-30): 4/4 submitted
- All ledger rows: 15/18 submitted
- Historical missed rows: 3
  - wr_dUqp7bT31nDzpO2n: 2026-07-26 pm, organization/org_nco-evolution
  - wr_6UPabCZJPoitVftv: 2026-07-27 am, organization/org_nco-evolution
  - wr_mFYMUMA_uwpQoDU6: 2026-07-27 pm, organization/org_nco-evolution

## Subject-report adjudication

- Verified claims: 6/8
  - C01: No Nova-AX run existed for task_x21RZj7Pog5HXkTi when task_yBa5BsqOujhOUKIA stopped producing output → 0
  - C02: No receipt existed for task_x21RZj7Pog5HXkTi in the same bounded window → 0
  - C03: No remediation loop exists for task_x21RZj7Pog5HXkTi → 0
  - C04: task_x21RZj7Pog5HXkTi remains reviewing/pending verification → "reviewing/pending"
  - C05: The cited two approved receipts belong to another task and are not reusable → "2 receipts; 2 consumed; 2 bound to cited task"
  - C06: Directive vdir_511c06cc-5695-4c79-aab2-3068a9ae731f binds task_x21RZj7Pog5HXkTi to task_yBa5BsqOujhOUKIA → {"id":"vdir_511c06cc-5695-4c79-aab2-3068a9ae731f","company_id":"org_nco-evolution","team_id":"team_gov-evolution-learning","loop_id":"","type":"audit_required","status":"dispatched","work_report_id":"completion_audit_task_x21RZj7Pog5HXkTi","task_id":"task_yBa5BsqOujhOUKIA","dispatched_at":"2026-07-30T19:42:44.735Z","last_error":null,"attempt_count":5,"next_attempt_at":null,"created_at":"2026-07-30T17:21:01.642Z","updated_at":"2026-07-30T19:42:44.735Z","subject_task_id":"task_x21RZj7Pog5HXkTi"}
- Unverified claims: 2/8
  - C07: task_yBa5BsqOujhOUKIA was running at the exact time its report text was emitted → "current task row is reviewing; no immutable task-status history row was found"
  - C08: The two HTTP_STATUS:000 observations prove that both services were down → "current shell cannot connect; sandbox also denies listen and PM2 RPC access, so client-side HTTP 000 does not identify the server-side cause"

## Remaining blockers

- task_yBa5BsqOujhOUKIA has no fresh verification run
- task_yBa5BsqOujhOUKIA has no approved receipt
- NCO completion binding was not attempted without a valid current-task receipt
- 3 company/team work-report obligations remain missed in the ledger
- Nova-AX and NCO connector calls were cancelled outside this collector

## Ground-truth files

- `/Users/nova-ai/project/nco/db/nco.db` — 966021120 bytes — SHA-256 `fccc14e2edbac074cbda30e73dab00d1e0bf7674873f44d9206a9631e14544c4`
- `/Users/nova-ai/project/nova-ax/db/nova-ax.db` — 69406720 bytes — SHA-256 `158362f27dab0dd0332be27bd461d991b3af8c03bdbe29c2714bcdf51e1af737`
- `/Users/nova-ai/project/nova-ax/evidence/org_nco-evolution/team_gov-evolution-learning/2026-07-30/audit-result.json` — 18179 bytes — SHA-256 `36a491cb583743ed89b244e881337ebc005240995e5974446497502889479e90`


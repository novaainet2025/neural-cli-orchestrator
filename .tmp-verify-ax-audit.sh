#!/bin/sh
sqlite3 /Users/nova-ai/project/nova-ax/db/nova-ax.db "SELECT id, task_id, status, passed_institutions, created_at FROM verification_runs WHERE id='vrun_e6aea119-8a79-48b3-82f3-e9645834ed59';"
sqlite3 /Users/nova-ai/project/nova-ax/db/nova-ax.db "SELECT id, run_id, status, consumed_at FROM verification_receipts WHERE id='vrcpt_e2051f15-9067-4c6f-9632-54d939728a37';"
sqlite3 /Users/nova-ai/project/nova-ax/db/nova-ax.db "SELECT id, status, latest_run_id FROM verification_loops WHERE id='vloop_047582eb-7a6b-4d47-a661-499eee16fb6f';"
sqlite3 /Users/nova-ai/project/nova-ax/db/nova-ax.db "SELECT id, loop_id, iteration, decision, run_id FROM verification_loop_attempts WHERE loop_id='vloop_047582eb-7a6b-4d47-a661-499eee16fb6f';"
shasum -a 256 /Users/nova-ai/project/nova-ax/evidence/audit-gov-evolution-evaluation-20260730/work-report.md

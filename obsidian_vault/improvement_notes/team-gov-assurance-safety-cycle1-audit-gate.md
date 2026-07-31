# team_gov-assurance-safety — cycle 1/3 audit gate pending injection

- **team:** `team_gov-assurance-safety` (Security Privacy and Safety)
- **HR snapshot:** score=6.1, completion=0%, n=6, sample=48h
- **date:** 2026-07-30
- **evidence tier:** T1

## Pattern

Gateway injects `verificationStatus: 'pending'` at task creation (`gateway.ts` L2155). Scorer gate treated any non-empty `verificationStatus` as requiring `approved` + `verificationReceiptId`. With zero approved receipts in 48h, completion numerator = 0 for all marked team tasks → score ≈ 0.1 × volume only (6.1 for n=6).

Same mechanism as `team_gov-government-transparency`, `team_research-visualization`, and 82 other teams (2026-07-30).

## Fix (cycle 1)

`AUDIT_APPROVED_COMPLETION` strict trigger narrowed to `verificationStatus NOT IN ('', 'pending')`. Initial `pending` injection is not an audit outcome.

Rollback: `NCO_SCORER_AUDIT_APPROVAL_GATE=off`.

## Mem0 key

`project_gov_assurance_safety_audit_gate_pending_injection`

## Not in scope

- Team deletion/deactivation (HR only)
- Gateway reviewing path fix (cycle 2)
- Volume formula change (n=6 is healthy; prior score=90 memos were n=1 volume floor)

## Related

- `REPORTS/2026-07-30-gov-assurance-safety-cycle1-discussion-R1.md`
- `REPORTS/2026-07-30-gov-transparency-audit-gate-regression.md`

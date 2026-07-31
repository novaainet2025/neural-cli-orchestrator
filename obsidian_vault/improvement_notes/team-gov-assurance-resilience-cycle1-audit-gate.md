# team_gov-assurance-resilience — cycle 1/3 audit gate + T1 evidence gap

- **team:** `team_gov-assurance-resilience` (Reliability and Resilience Review)
- **HR snapshot:** score=6.1, completion=0%, n=6, sample=48h
- **date:** 2026-07-30
- **evidence tier:** T1

## Pattern (primary — scorer)

Gateway marks team tasks `organizationAuditRequired:true`. Legacy scorer gate treated non-empty `verificationStatus` (including enqueue-injected `pending`) as requiring `approved` + `verificationReceiptId`. Zero approved receipts in 48h → completion numerator = 0 → score ≈ 0.1 × volume (6.1 for n=6).

Same mechanism as `team_gov-assurance-safety`, `team_gov-command-incident`, `team_gov-government-transparency` (2026-07-30).

**Fix (already applied via safety cycle 1):** `AUDIT_APPROVED_COMPLETION` strict trigger narrowed to `verificationStatus NOT IN ('', 'pending')`.

Rollback: `NCO_SCORER_AUDIT_APPROVAL_GATE=off`.

## Pattern (secondary — operational)

`data/team-runner/team_gov-assurance-resilience-2026-07-30.md`: `done:` + gateway/WS/backup `미확인` coexist; hermes 57%, ollama 77%, cursor-agent idle/working mismatch. T3-only observation loop.

**Fix (cycle 1):** `RESILIENCE_REVIEW_RESPONSE_CONTRACT` on HR `companyRunId` runs only (`GATE-RESILIENCE-C1-R1`).

## Mem0 key

`project_gov_assurance_resilience_audit_gate_pending_injection`

## Not in scope

- Team deletion/deactivation (HR only)
- Gateway reviewing path fix (cycle 2)
- hermes routing CB (blast radius unverified)

## Related

- `REPORTS/2026-07-30-gov-assurance-resilience-cycle1-discussion-R1.md`
- `REPORTS/2026-07-30-gov-assurance-safety-cycle1-discussion-R1.md`
- `data/error-prevention/gov-assurance-resilience-cycle1-gate-update-2026-07-30.json`

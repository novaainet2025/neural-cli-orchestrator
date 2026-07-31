# Audit gate regression — `team_gov-government-transparency` (HR cycle 1/3)

**Session:** `sess_G_VtYhaJ0EvrcPAi`  
**Team:** Transparency Appeals and Public Record  
**Recorded:** 2026-07-30 (cycle 1, discussion R1 deliverable)

---

## Executive summary

A global team-score collapse (`completion=0` for all 85 active teams) was caused by retroactive application of `AUDIT_APPROVED_COMPLETION` in `src/core/team-scorer.ts`. The gate requires Nova-AX 6/6 receipts for **all** completed team tasks, but the audit pipeline has produced **zero** `verificationStatus='approved'` rows in the last 48h and **zero** `reviewing` queue entries. Legacy tasks completed before audit marking cannot satisfy the gate.

**Correct action for cycle 1:** Do not deploy scorer changes from this team session. Wait for the owning session (working-tree mitigation already present). Contribute non-overlapping artifacts: this report, `scripts/audit-pipeline-health.sh`, and `tests/audit-gate-invariants.test.ts`.

---

## T1 evidence (fixed — do not re-investigate)

| # | Observation | Source |
|---|-------------|--------|
| 1 | `team_gov-government-transparency`: score=5.5, grade=F, completion=0, n=5, maxN=19, sample=48h | `GET :6200/api/teams/scores` |
| 2 | All 85 active teams: completion=0; mean score 5.91; zero teams ≥90 | Same API |
| 3 | 48h team `completed` tasks: 628; `verificationStatus='approved'`: 0; `reviewing`: 0 | `db/nco.db` |
| 4 | Transparency team 48h terminal tasks: 5, all `completed`, response 1076–5039 bytes, zero failures | `db/nco.db` |
| 5 | Root cause: `AUDIT_APPROVED_COMPLETION` built into dist (~10:39Z), backend restart (~10:44Z) — retroactive 0% | git + PM2 logs |
| 6 | Working-tree mitigation: legacy rows without audit markers keep prior `status`; marked rows require receipt; toggle `NCO_SCORER_AUDIT_APPROVAL_GATE` | `src/core/team-scorer.ts` L202–237 |
| 7 | Simulation (working-tree source, readonly DB): transparency 95.5/S/100% (5/5); ≤5 teams at completion=0; mean 90.23; 78 teams ≥90 | prior session simulation |

---

## Invariants (must hold after mitigation deploy)

1. **Legacy grandfathering:** `completed` rows **without** `organizationAuditRequired` or `verificationStatus` count toward completion.
2. **Marked strictness:** rows **with** audit markers require `verificationStatus='approved'` **and** non-empty `verificationReceiptId`.
3. **Bounded completion:** `completion ≤ 100` for all teams (completed ⊆ terminal).
4. **Control-plane exclusion:** `auditControlPlane` / `verificationDirectiveId` tasks remain outside team performance samples.
5. **Kill-switch:** `NCO_SCORER_AUDIT_APPROVAL_GATE=off` disables the SQL fragment entirely (coarser than mitigation).

---

## Audit pipeline gap (independent of scorer)

Gateway enqueue (`src/server/gateway.ts` L2150–2160) injects `organizationAuditRequired: true` for team tasks. On normal API completion, `requiresNovaAxAudit` routes team tasks to `reviewing` (L2236–2238). Yet live DB shows **zero** `reviewing` and **zero** approved receipts in 48h.

**Hypothesis (cycle 1, path analysis only):** Most team-runner / scheduler completions bypass the gateway `.then()` path that demotes `completed` → `reviewing`. `persistRecoveredTaskResult` in `task-queue.ts` L192–211 applies the same demotion only for startup recovery, not for all completion paths.

Track with AP KPIs (see `scripts/audit-pipeline-health.ts`), not completion alone.

**CommandGate note (2026-07-30):** NCO agent `runCommand` allowlist includes `npx`/`tsx` but not `bash` or `sqlite3`. Agents must use the TypeScript twin; humans may still run the bash script locally.

---

## Rollback procedure

| Step | Action |
|------|--------|
| 1 | Revert scorer commit or wait for owning session merge |
| 2 | `unset NCO_SCORER_AUDIT_APPROVAL_GATE` (default = gate on with mitigation) |
| 3 | `npm run build` + PM2 restart (`npm run pm2:stop` / `npm run pm2:start`) |
| 4 | Snapshot before/after: `curl -s localhost:6200/api/teams/scores` |
| 5 | Run `npx vitest run tests/audit-gate-invariants.test.ts` — must pass before declaring recovery |

Emergency only (not recommended): `NCO_SCORER_AUDIT_APPROVAL_GATE=off` — disables audit receipt check for **new** marked tasks too. Requires lease owner + 24h expiry + REPORT amendment.

---

## Verification commands

```bash
# Live score (pre-deploy: expect completion=0)
curl -s localhost:6200/api/teams/scores

# Pipeline KPI dump (CommandGate-safe for NCO agents)
npx tsx scripts/audit-pipeline-health.ts

# Invariant tests (no team-scorer.ts edit required)
npx vitest run tests/audit-gate-invariants.test.ts

# Post-deploy success (from simulation baseline)
# transparency: score~95.5, grade S, completion 100, n=5
# teams with completion=0: <=5
```

Human/lease-owner shell (bash not in agent allowlist):

```bash
bash scripts/audit-pipeline-health.sh
```

---

## Anti-gaming safeguards (cycle 2+ proposals)

- **Cutover timestamp** `AUDIT_ROLLOUT_AT`: tasks created after rollout cannot complete without audit markers.
- **Public diff:** store before/after API JSON under `data/nova-ax-audit-staging/`.
- **Split HR grades:** completion (delivery) vs AP-4 (audit compliance).
- **Legacy ratio cap:** warn if >80% of 48h completed team tasks remain unmarked after cutover.

---

## Team cycle 1 contributions

| Artifact | Path | Owner boundary |
|----------|------|----------------|
| Public record | This file | REPORTS |
| Pipeline KPI script | `scripts/audit-pipeline-health.ts` (+ `.sh` for humans) | scripts/ |
| Invariant tests | `tests/audit-gate-invariants.test.ts` | tests/ (not `team-scorer.test.ts`) |
| Path analysis | § Audit pipeline gap above | documentation only |

**Explicitly out of scope for this team session:** editing `src/core/team-scorer.ts`, build/deploy, toggling production env without lease.

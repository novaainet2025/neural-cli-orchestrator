# Decision & Coordination Office — HR cycle 1/3 (Discussion R1)

**Session:** `sess_aBHXSVxM1Fg6Nq5N`  
**Team:** `team_ax-decision-coordination-2026` (`ax-decision-coordination`)  
**HR snapshot:** score=6.1, completion=0%, sample=48h/6  
**Recorded:** 2026-07-30

---

## Executive summary

`completion=0%` is **primarily a global scorer regression** (`AUDIT_APPROVED_COMPLETION` without legacy grandfathering in deployed dist), not proof that this team delivered zero value. Independently, the team's **operational charter was structurally blocked**: team-runner injected only aggregate counts, so four consecutive daily reports could not name task IDs, in-progress work, or work-report linkage — the exact gaps listed in `REPORTS/2026-07-30-Decision-and-Coordination-Office-오후.md`.

**Cycle 1 bounded fix (this session):** mirror `gov-evolution-learning` evidence injection for `ax-decision-coordination` in `src/core/work-report-scheduler.ts` and `scripts/team-runner.sh`, gated by `NCO_DECISION_COORDINATION_EVIDENCE_CONTEXT` (default on; set `off` to roll back without rebuild).

**Explicitly out of scope:** editing `src/core/team-scorer.ts` audit gate (owned by parallel mitigation session per `REPORTS/2026-07-30-gov-transparency-audit-gate-regression.md`).

---

## T1 evidence

| # | Observation | Source |
|---|-------------|--------|
| 1 | HR directive: score=6.1, completion=0%, 48h/6 | session prompt |
| 2 | Global audit gate collapsed all teams to completion=0 when legacy rows lack approved receipts | `REPORTS/2026-07-30-gov-transparency-audit-gate-regression.md` §T1 |
| 3 | Team reports 4 snapshots: "원본 데이터 미제공" for task IDs, in-progress work, hermes failures | `REPORTS/2026-07-30-Decision-and-Coordination-Office-오후.md` |
| 4 | team-runner completed daily output 2026-07-28..30 | `logs/team-runner.log` |
| 5 | Pointer fresh (`2026-07-30`) | `data/team-runner/team_ax-decision-coordination-2026.last` |
| 6 | Prior pattern: `gov-evolution-learning` fixed by evidence block in work-report-scheduler; team-runner path was missing | `scripts/team-runner.sh` comment L106-112 |

---

## Rollback

| Step | Action |
|------|--------|
| 1 | `export NCO_DECISION_COORDINATION_EVIDENCE_CONTEXT=off` |
| 2 | Next team-runner / work-report cycle uses prior prompt shape |
| 3 | Revert commits touching `work-report-scheduler.ts` + `team-runner.sh` if needed |

---

## Verification commands

```bash
npx vitest run src/core/work-report-scheduler.test.ts -t "coordination"
npx tsc --noEmit
```

Post team-runner run, prompt for Decision & Coordination Office should contain `[coordination_task_evidence]` lines with task `id=`.

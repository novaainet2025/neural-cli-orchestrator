# Strategic Command — HR Improvement Cycle 1/3, Discussion R1

**Session:** `sess_BuLxUXW8YF4faC40`  
**Team:** `team_gov-command-strategic` / `gov-command-strategic`  
**Recorded:** 2026-07-30  
**Directive:** score=6.1, completion=0%, sample=48h/6

---

## Executive summary

**Root cause (T1):** `completion=0%` is **not** a Strategic Command charter defect. It is a **scorer + enqueue desync**: `gateway.ts` injected `verificationStatus: 'pending'` at task creation while `AUDIT_APPROVED_COMPLETION` treated any non-approved `verificationStatus` as a strict gate failure. With **zero** `verificationStatus='approved'` receipts in 48h, every completed team task scored as 0% numerator — a fleet-wide artifact (85/85 teams at completion=0 before fix).

**Cycle 1 fix (bounded, reversible):**
1. `GATE-STRATEGIC-R1` — stop injecting `verificationStatus: 'pending'` at enqueue; set it only in `markTaskAuditQueued` when status=`reviewing`.
2. Narrow scorer gate to require receipts only when `verificationStatus` is a **post-audit** state (`NOT IN ('', 'pending')`), preserving `organizationAuditRequired` as intent-only metadata.

---

## Discussion R1 — three-team positions

### 자가학습팀 (Self-learning)

**독립 제안:** Obsidian에 `[[project_audit_gate_enqueue_desync]]` 노트를 추가하고, Mem0에 "enqueue pending ≠ audit engaged" 패턴을 저장한다. Strategic Command의 48h 표본 6건은 업무보고·HR 지시 태스크이며, `REPORTS/2026-07-26`~`30` Strategic Command 보고서 7건이 실제 산출물로 존재한다 — 팀은 보고하고 있으나 스코어러가 인정하지 못한 상태.

**상호 평가:** 자가개선팀의 enqueue/scorer 분리는 정확하다. 중복에러방지팀의 False Report 교차검증과 일치 — raw `/api/teams` 완료율(64.7%) vs HR score(0%) 불일치가 게이트 아티팩트를 증명한다.

**반대·위험:** 게이트 완화 시 `verificationStatus='rejected'` completed 행이 다시 성공으로 잡힐 수 있다 → SQL이 `rejected`만 strict 대상으로 남기는지 반드시 테스트로 고정해야 한다.

### 자가개선팀 (Self-improvement)

**독립 제안:** `src/core/team-scorer.ts` + `src/server/gateway.ts` 최소 diff. `NCO_SCORER_AUDIT_APPROVAL_GATE=off` 킬스위치는 유지. `UI_AUDIT_APPROVAL_TEAM_ID` 자기참조 예외는 그대로.

**상호 평가:** 자가학습팀의 "산출물 존재 vs score 0%" 관찰은 T1 근거로 채택. 중복에러방지팀이 지적한 transparency 사이클(`REPORTS/2026-07-30-gov-transparency-audit-gate-regression.md`)과 동일 근본원인 — 팀별 중복 수정 금지, 공통 게이트 한 번만 수정.

**반대·위험:** 영수증 백필 파이프라인(`POST /api/tasks/:id/verification`, 사용률 0%)은 cycle 2+ 과제. cycle 1에서 게이트만 풀면 HR 점수는 회복되나 **감사 준수율(AP)** 은 여전히 0%일 수 있다 — HR completion과 AP를 분리 보고해야 한다.

### 중복에러방지팀 (Error prevention)

**독립 제안:** `tests/audit-gate-invariants.test.ts`에 `team_gov-command-strategic` 회귀 케이스 추가. `scripts/audit-pipeline-health.ts`로 AP KPI 병행 모니터링. False Report 판정: "팀 개선 필요" 보고서 중 scorer-only 원인은 **거짓 양성**.

**상호 평가:** 자가개선팀 diff는 bounded(2 파일 + 테스트). 자가학습팀 Obsidian 연동은 cycle 2에서 해도 됨 — 코드 우선.

**반대·위험:** `NCO_SCORER_AUDIT_APPROVAL_GATE=off` 긴급 롤백은 rejected 행까지 통과시켜 False Report를 **반대 방향**으로 만든다. cycle 1 롤백은 **git revert + rebuild**만 허용.

---

## 합의 실행 설계

| Step | Owner | Action | Reversible via |
|------|-------|--------|----------------|
| 1 | 자가개선 | `GATE-STRATEGIC-R1` gateway enqueue + scorer SQL | git revert; `NCO_SCORER_AUDIT_APPROVAL_GATE=off` |
| 2 | 중복에러방지 | `audit-gate-invariants` strategic fixture | test delete |
| 3 | 자가학습 | 본 REPORT + Obsidian cross-link (cycle 2) | REPORT amend |
| 4 | 공통 | `npm run build` + vitest + API snapshot | PM2 restart |

**명시적 비범위:** 팀 삭제/비활성화, HR lifecycle 변경, Nova-AX 영수증 백필 구현.

---

## 검증 가능한 성공 기준 (cycle 1)

| # | Criterion | Method |
|---|-----------|--------|
| S1 | `npx vitest run tests/audit-gate-invariants.test.ts` exit 0 | vitest |
| S2 | Strategic Command: `completion > 0`, `n = 6` (48h) | `computeTeamScores()` or `GET /api/teams/scores` |
| S3 | Fleet: teams with `completion=0` ≤ 5 (not 85/85) | same API |
| S4 | `rejected` verificationStatus completed rows **do not** count toward completion | invariant test `audit-rejected` |
| S5 | `pending` + `organizationAuditRequired`-only rows **do** count | strategic fixture + pending case |

---

## T1 evidence ledger

| Observation | Source |
|-------------|--------|
| HR directive: score=6.1, completion=0%, n=6, sample=48h | Dashboard snapshot `.codex-nco-dashboard/.../page-2026-07-30T10-54-27-431Z.yml` |
| Strategic Command 산출물 7건 (`REPORTS/2026-07-26`~`30`) | filesystem |
| team-runner: 48h raw 완료율 64.7% (11/17) vs scorer 0% | `data/team-runner/team_gov-command-strategic-2026-07-30.md` |
| Fleet-wide 85/85 completion=0 before gate fix | `REPORTS/2026-07-30-시각화-미디어팀-오후.md`, transparency regression report |
| `verificationStatus='approved'` count = 0 in 48h | `REPORTS/2026-07-30-gov-transparency-audit-gate-regression.md` |
| Enqueue injected pending at L2154–2157 | `src/server/gateway.ts` (pre-fix) |

---

## Rollback

```bash
git revert <this-commit>   # or restore gateway/scorer lines
npm run build && npm run pm2:stop && npm run pm2:start
curl -s localhost:6200/api/teams/scores | jq '.[] | select(.teamId=="team_gov-command-strategic")'
```

Emergency (coarser): `NCO_SCORER_AUDIT_APPROVAL_GATE=off` — disables rejected strictness too; requires REPORT amendment.

---

## 검증 영수증

- **[변경]** `src/core/team-scorer.ts` — `AUDIT_APPROVED_COMPLETION` pending/empty exempt; `src/server/gateway.ts` — GATE-STRATEGIC-R1 enqueue; `tests/audit-gate-invariants.test.ts` — strategic fixture
- **[검증방법]** `npx vitest run tests/audit-gate-invariants.test.ts` (post-edit)
- **[등급]** T1 (source + test fixture); live API 재측정은 build/deploy 후
- **[Gap]** deploy 전 라이브 API score 미확인 — 의도적 (build 필요)
- **[미검증항목]** Mem0/Obsidian sync; AP pipeline KPI post-deploy snapshot

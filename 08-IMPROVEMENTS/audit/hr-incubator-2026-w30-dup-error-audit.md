# 중복에러방지팀 감사 — team_hr-incubator-2026-w30 (HR Incubator 2026-W30)

- 감사일: 2026-07-28 (r2 re-verify, ~04:00 KST)
- 역할: Code Reviewer / 중복에러방지팀
- 표본: 48h 팀 태스크 + 7d raw vs INFRA-excluded + self-improve cycle1 교차검증
- DB 스냅샷: `/tmp/nco-hr-dup-audit-r2.db` (565829632 bytes, copied 2026-07-28 03:59)
- 산출물: 본 파일 + `hr-incubator-2026-w30-audit.json`
- **CB/Gate 패치 = diff 0 (파일 없음)** — src/·teams/lifecycle **미변경**

---

## FACTS (T1 — 본 세션 직접 조회)

### Team row

```json
{
  "id": "team_hr-incubator-2026-w30",
  "is_active": 1,
  "name": "HR Incubator 2026-W30",
  "organization_id": "org_knowledge-diet",
  "status": "improving",
  "last_score": 81.5,
  "last_sample_size": 7,
  "retired_at": null,
  "last_checked_at": "2026-07-27T18:50:00.004Z"
}
```

스키마 주의: 에이전트 컬럼은 `assigned_to` (선행 감사의 `assigned_agent` 표기는 스키마와 불일치; 값은 동일 행에서 재확인).

### 48h tasks (`team_id` only) — 10 rows: completed 6 / failed 4

| id | status | assigned_to | error (trunc) | created_at | parent |
|---|---|---|---|---|---|
| task_LaiCTxfL9_MD-KcU | failed | hermes | Circuit breaker open for agent hermes (generic) | 2026-07-26 01:57:01 | — |
| task_DUy7JXH50l91ZQAy | completed | codex | — | 2026-07-26 05:53:41 | — |
| task_SaSK5GegPXqBTgJz | completed | hermes | — | 2026-07-26 07:11:00 | — |
| task_KoX43DEXQwsFhqZ5 | completed | codex | — | 2026-07-26 15:32:44 | — |
| task_dPluiM6mYO0_TShj | failed | claude-code | queue_wait_timeout: provider claude-code busy for 1800000ms | 2026-07-27 00:19:32 | — |
| task_LWocTfAMYEW4juI0 | failed | claude-code | queue_wait_timeout: provider claude-code busy for 1800000ms | 2026-07-27 01:15:44 | task_dPluiM6mYO0_TShj |
| task_JumiwT-xEFn-zfHQ | completed | claude-code | — | 2026-07-27 01:52:41 | task_dPluiM6mYO0_TShj |
| task_pGu0BkO2cf2R12-0 | completed | codex | — | 2026-07-27 05:28:57 | — |
| task_VnTZtkgkcpgPwPhy | failed | claude-code | subprocess exited with code 1: Invalid API key · Fix external API key | 2026-07-27 17:18:57 | — |
| task_ghJmJqiiH2DJB0nL | completed | ollama | — | 2026-07-27 17:19:28 | — |

### Failed error signatures (48h)

| error | cnt | assigned_to |
|---|---|---|
| queue_wait_timeout: provider claude-code busy for 1800000ms | 2 | claude-code |
| subprocess exited with code 1: Invalid API key · Fix external API key | 1 | claude-code |
| Circuit breaker open for agent hermes (generic) | 1 | hermes |

### Other tables (T1)

| Query | Result |
|---|---|
| `SELECT COUNT(*) FROM false_reports` | **0** |
| false_reports ⨝ tasks WHERE team_id=… | **0** |
| `hourly_role_audits` WHERE subject_id LIKE '%hr-incubator%' | **0** |
| `work_reports` for team | **8** |
| 7d raw terminal | **13 completed / 152 failed / 165 total (7.9%)** |
| 7d INFRA-excluded | **13 completed / 2 failed / 15 total (86.7%)** |

### Verification commands (this session)

| Command | exit | Result |
|---|---|---|
| `npm run test:run -- src/core/task-queue.p11.test.ts` | **0** | **16 passed** (1 file) |
| `npm run typecheck` | **0** | tsc --noEmit clean |
| `npm run build` | **0** | tsc build clean |
| `shasum -a 256 …cycle1.patch` | **0** | `a9ec40046186ec0e2e0b8b26139fd43b16eb2e9e5070089e8e5e120ff6d9622b` |
| `git apply --check --reverse …cycle1.patch` | **1** | does not apply (HEAD drift) |

---

## 0. 요약

| 항목 | 결과 |
|---|---|
| 라이브 DB 조회 (T1) | **완료** — `/tmp/nco-hr-dup-audit-r2.db` |
| 허위 보고(`false_reports`) | **0** (T1) |
| 일일보고서 12/164(7.3%) ↔ DB raw | **근접 일치** 13/165 (7.9%) — False Report **아님** (`METRIC_CONTEXT_MISMATCH` vs INFRA-excl 86.7% / lifecycle 81.5) |
| self-improve cycle1 핵심 클레임 | **PASS** (태스크 4건·P11 분류·SHA·테스트/빌드) |
| cycle1 patch 역적용 | **현재 HEAD 기준 FAIL** — evolution-learning 후속 변경으로 컨텍스트 불일치 |
| Circuit Breaker / Gate 임계치 변경 | **불필요 (diff 0)** |
| 팀 비활성/퇴출 | **수행하지 않음** (HR 전권) |

---

## 1. 실패 패턴 분석

관측된 48h 실패 3종:

1. **Circuit breaker open (hermes)** — 인프라 가용성. `team-scorer` `INFRA_EXCLUSION`이 품질 표본에서 제외. P11 `isTransientFailure`가 failover 대상.
2. **queue_wait_timeout (claude-code ×2)** — provider queue 포화. INFRA 제외 + P11 failover 대상. 동일 parent 체인에서 후속 `task_JumiwT-xEFn-zfHQ` completed 관찰.
3. **Invalid API key (claude-code)** — 인증 실패. INFRA **미제외(의도적)**. P11이 subprocess/auth를 failover 대상으로 분류 (후속 `task_ghJmJqiiH2DJB0nL` ollama completed).

**미커버 신종 시그니처: 없음** (본 48h 표본 기준).

---

## 2. False Report 이력

| 출처 | 판정 | 근거 |
|---|---|---|
| `false_reports` 테이블 | **이력 0건** | COUNT=0, team join=0 |
| 일일보고서 7.3% (12/164) | **False Report 아님** | DB raw 7.9% (13/165) 근접; `buildTeamDataContext`는 INFRA 없이 raw 주입 → lifecycle 81.5와 **동시 참 가능** |
| 지시문 score=79.1 / completion=83.3% | **스냅샷 불일치, FR 미확정** | 현재 DB `last_score=81.5`, INFRA-excl completion 86.7%(15표본). 지시문 수치의 생성 시각·집계식은 미추적 |
| 자가개선 “p11 13 passed” | **당시 가능 / 현재 불일치** | 본 세션 16 passed — HEAD에 `isEvolutionLearningRecoverableFailure` 테스트 추가됨. 날조가 아니라 **후속 drift** |
| 자가개선 “reverse apply exit 0” | **현재 시점에서는 거짓에 해당하지 않되 재사용 불가** | 본 세션 reverse check exit 1. 당시 HEAD에서는 통과했을 수 있음. **현재 롤백 경로로는 신뢰 불가** |

---

## 3. self-improve cycle1 교차검증

출처: `docs/self-improve/hr-incubator-2026-w30-cycle1-evidence-2026-07-28.md` + `…-cycle1.patch`  
대조: HEAD `src/core/task-queue.ts` / `task-queue.p11.test.ts` / `team-scorer.ts` / DB r2

| # | 클레임 | 판정 | 등급 | 근거 |
|---|---|---|---|---|
| C1 | 48h 10건 (6/4) | **PASS** | T1 | r2 DB |
| C2–C5 | 4 failed task rows | **PASS** | T1 | id/error/assigned_to 일치 |
| C6–C10 | P11 queue/auth/CLI + 제외 + toggle | **PASS** | T1 | `task-queue.ts:345-361`, `:1175` |
| C11 | p11 테스트 통과 | **PASS** (건수 drift) | T1 | **16**/16 now (claimed 13) |
| C12 | typecheck/build 0 | **PASS** | T1 | both exit 0 this session |
| C13 | work_events 3건 | **PASS** | T1 | evt_CfCMr9XaZtI3N2sk / evt_IGet7dL3zRPjfJAj / evt_1fvEwtOFcDNNoCMf |
| C14 | lifecycle active/improving/81.5/n=7 | **PASS** | T1 | team join query (`last_checked_at` 18:50로 갱신됨) |
| C15 | patch SHA-256 `a9ec4004…` | **PASS** | T1 | shasum exact match |
| C16 | patch ↔ HEAD 역적용 가능 | **FAIL (now)** | T1 | `git apply --check --reverse` exit 1 — evolution-learning 블록이 patch 이후 추가됨 |

신뢰도: cycle1 **기능 클레임은 높음**. patch 파일은 **감사 증거**로는 유효하나 **현재 HEAD 단독 롤백 수단으로는 불충분**. 즉시 완화는 evidence가 명시한 `NCO_P11_FAILOVER_ENABLED=0`.

---

## 4. INFRA_EXCLUSION · CB/Gate 판정

### 4.1 Scorer (`team-scorer.ts:178`)

```text
INFRA_EXCLUSION:
  orphaned:% | Circuit breaker open% | provider_unavailable:% | queue_wait_timeout:%
  (+ gateway-down unknown: failure pattern … port 6200)
```

| 에러 시그니처 | INFRA 제외? | P11 failover? |
|---|---|---|
| Circuit breaker open for agent hermes … | YES | YES |
| queue_wait_timeout: provider claude-code … | YES | YES |
| subprocess … Invalid API key | **NO** | YES |

### 4.2 Circuit Breaker 기본값 (`circuit-breaker.ts`)

- `failureThreshold = 3`
- `resetTimeoutMs = 60_000`
- `halfOpenMaxAttempts = 1`

변경 필요성: **없음**. 임계치 조정은 queue TOCTOU·인증 실패를 해결하지 못하고, CB 실패는 이미 INFRA에서 제외됨.

### 4.3 Gate 규칙

**diff 0.** `learning-stage-gate` / CB threshold patch **작성하지 않음**.

이유:

1. 관측 실패 시그니처가 모두 INFRA 또는 P11로 이미 분류됨.
2. false_reports=0, 미커버 신종 없음.
3. CB 임계 변경은 이 팀의 raw→quality 괴리(METRIC_CONTEXT_MISMATCH)를 고치지 않음 — 필요 시 별도 work-report context 정합 과제.

---

## 5. CB/Gate 결정문

```text
RULE CHANGE: NO
DIFF: 0
PATCH FILE: (none)
```

---

## 6. 미검증 / Gap

1. NCO `:6200` runtime failover E2E — **미검증** (gateway 도달성은 본 세션에서 재측정하지 않음)
2. 지시문 score 79.1 / completion 83.3%의 원천 시각·집계식 — **미추적**
3. cycle1 patch를 현재 HEAD에서 reverse로 완전 롤백 — **불가 확인됨**; 대안 롤백=`NCO_P11_FAILOVER_ENABLED=0` 또는 수동 diff
4. 저장소 전체 clean / full test suite — **미실행**

**Gap ≈ 15%** (runtime E2E + 지시문 스냅샷 추적 + patch reverse drift).

---

## 검증 영수증

- [변경] `08-IMPROVEMENTS/audit/hr-incubator-2026-w30-dup-error-audit.md`, `hr-incubator-2026-w30-audit.json` — r2 T1 재검증 반영. **src/·CB/Gate diff 0**. 팀 lifecycle 미변경.
- [검증방법] `cp db/nco.db → /tmp/nco-hr-dup-audit-r2.db`; `node .tmp-diag/hr-audit-r2.mjs` / `r2b.mjs`; `npm run test:run -- src/core/task-queue.p11.test.ts` → 16 passed; `npm run typecheck` → 0; `npm run build` → 0; `shasum -a 256` patch match; `git apply --check --reverse` → exit 1
- [등급] T1 (DB rows, file content, command exit)
- [Gap] ~15%
- [미검증항목] gateway runtime failover; 지시문 79.1/83.3 원천; full suite

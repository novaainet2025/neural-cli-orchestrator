# team_content-build — cycle 2 중복에러방지 Gate/Circuit Breaker 감사 보고서

- **팀**: 중복에러방지팀 (읽기 전용 설계·검토)
- **대상**: `team_content-build` (고품질 콘텐츠 제작팀), HR cycle 2/3
- **짝 산출물**: `data/error-prevention/content-build-cycle2-gate-update-2026-07-29.json`
- **성격**: auto-audit·tasks 실패 이력 교차검증 + Gate/CB 규칙 설계·검토. **src/ 코드 diff 0**, 팀 lifecycle 변경 0.
- **작성**: 2026-07-29

---

## 0. 결론

| 항목 | 판정 |
|---|---|
| 근본원인 (T1 문서·소스) | 선언된 선행조건 차단이 `failure-pattern: agent reported error` 또는 false `completed`로 **이중 오분류** → 동일 prompt **5회 dispatch / 4회 executor 교체** |
| 자가개선팀 `STAGE_OUTCOME: BLOCKED` 계약 (commit `91d1848`) | **검토 승인** — fail-closed 4필드 + fingerprint 중복 억제가 요구사항과 정합 |
| 과거 2건 (`task_eMva63ao2fjDYEaX`, `task_jX5LC9uaq8hTO4kP`) 소급 재분류 | **없음 (설계상)** — 계약 필드 부재 → 여전히 `failed` |
| score 61.3 / completion 62.5% / 48h·n=8 | **이번 수정만으로 불변** — 재발 방지 전용; cycle 3에서 “점수 동일=미수정” 판정은 오판 |
| CB `failureThreshold` 조정 | **없음 (diff 0)** — 원인은 프로바이더 장애가 아니라 분류·재dispatch |
| 이번 사이클 Gate 룰 **적용** | **보류** — 구현된 계약의 E2E emit 관측 전; 제안안만 기록 |

---

## 1. 증거 출처 (Evidence Tier)

| 등급 | 자료 | 용도 |
|---|---|---|
| **T1** | `docs/self-improve/content-build-cycle2-prerequisite-block-learning-2026-07-29.md` | 48h 8행 표본, workflow `wfr_gPC_-rytCy-bkS4X`, dispatch 5회·교체 4회, DB replay JSON |
| **T1** | `improvement_notes/team_content-build_2026-07-29.md` | misclassified 2건 ID, orphan_requeue 1건 |
| **T1** | `src/core/stage-outcome.ts` | `parseBlockedStageOutcome` fail-closed 파서 |
| **T1** | `src/server/gateway.ts:157-175` | `classifyDeclaredPrerequisiteBlock` |
| **T1** | `src/core/company-orchestrator.ts:734-737,1688-1733,1842-1855` | `isCompanyRunBlocked`, `applyBlockedStageOutcome`, `dispatchStage` 계약 주입 |
| **T1** | `src/core/blocked-outcome-audit.test.ts` | 회귀 14 `it` (실측 픽스처 A/B 포함) |
| **T1** | `src/server/detect-failed-completion.test.ts` | gateway 회귀 18 `it` |
| **T1** | `src/core/company-orchestrator.test.ts:799-873` | structured BLOCKED + duplicate dispatch 0건 |
| **T1 부재** | `data/auto-audit/` | Glob 0건 — 팀 전용 auto-audit 스트림 없음 |
| **미실행** | `sqlite3 db/nco.db`, `npx vitest run`, `npx tsc --noEmit` | 본 세션 Shell/MCP Auto-review 차단 |

---

## 2. 교차검증 — auto-audit vs content-build 실패 이력

### 2.1 auto-audit 로그

| 확인 | 결과 |
|---|---|
| `data/auto-audit/**` | **0 files** (저장소 내 전용 스트림 부재) |
| `REPORTS/2026-07-29-중복에러방지팀-오후.md` | 동일 결론: `ls data/auto-audit/` → No such file |
| 대체 T1 | `tasks` + `work_events` (learning doc §이벤트 분류 전환) |

**판정**: auto-audit 계층 교차검증은 **데이터 부재로 수행 불가**. tasks/work_events 기반 교차검증으로 대체했으며 수치를 날조하지 않음.

### 2.2 content-build 48h 터미널 8행 (learning doc T1 인용)

| task | executor | status | 패턴 |
|---|---|---|---|
| `task_vaJ7ohqY_sFkEqHT` | opencode | failed | `discussion_insufficient_valid_proposals:0/2` — **일반 실패** |
| `task_ZrMFUlB8oVrQxaN6` | codex | completed | 정상 산출 |
| `task_ju0xiKaQzhTaP4K3` | opencode | completed | 정상 산출 |
| `task_Ej435t1Uq1RH4bzX` | hermes | completed | 정상 산출 |
| `task_eMva63ao2fjDYEaX` | codex | failed | **정당 차단 → 일반 실패 오분류** |
| `task_-UDCDk5z_ewqwLGf` | ollama | completed | **정당 차단 → false completed** |
| `task_jX5LC9uaq8hTO4kP` | codex | failed | **정당 차단 → 일반 실패 오분류** |
| `task_BDQvIauXahtPrvD3` | ollama | completed | **정당 차단 → false completed** |

score 재계산 (learning doc): `61.3 / 62.5% / n=8` — **지시문과 일치** (본 세션 재실행은 미검증).

### 2.3 동일 workflow 중복 dispatch (T1 learning doc)

```text
workflow_run_id = wfr_gPC_-rytCy-bkS4X
workflow_stage  = review
prompt_sha3_256 = 3f4bc9e563de66effadb047905f83299a437104060be1d120b2b83dc90173788

task_eMva63ao2fjDYEaX -> task_-UDCDk5z_ewqwLGf -> task_jX5LC9uaq8hTO4kP -> task_BDQvIauXahtPrvD3 -> task_alFSa9jpYqUwmgBA
codex -> ollama -> codex -> ollama -> codex
failed -> completed -> failed -> completed -> running
```

- 전체 dispatch: **5**
- 중복 (첫 행 제외): **4**
- 인접 executor 교체: **4**

---

## 3. 판정표 — 정당 BLOCKED / 근거 없는 BLOCKED / 일반 실패

| # | 분류 | 진입 조건 (코드 기준) | 허용 동작 | 차단·억제 동작 | 회귀 테스트 |
|---|---|---|---|---|---|
| **A** | **정당 BLOCKED** | prompt 선행조건 선언 **AND** `status:`/`error:` 접두사 **AND** `STAGE_OUTCOME: BLOCKED` **AND** `BLOCKER_FINGERPRINT` (8–240자) **AND** `BLOCKER_EVIDENCE` (비-placeholder, ≥8자) **AND** `EVIDENCE_TIER: 1` | Gateway: `cancelled` + `blocked-prerequisite: declared prerequisite unavailable`. Orchestrator: `stage=blocked`, 하류 `skipped`, `run=partial`, `summary.failed=0` | `isCompanyRunBlocked` → iteration/failover/dispatch **단락**; run 내 fingerprint **1회만** 기록 | `blocked-outcome-audit` 판정1·5; `detect-failed-completion` prerequisite 2건; `company-orchestrator.test` structured BLOCKED |
| **B** | **근거 없는 BLOCKED** | `error: BLOCKED` 등 자연어만, 또는 4필드 중 **하나라도** 누락/placeholder/Tier≠1 | **기존 실패 경로 유지** — `failure-pattern: agent reported error` | 재시도·failover **허용** (False Report 억제 방지) | `blocked-outcome-audit` 판정2 (12 deny case); `detect-failed-completion` “계약 없는 BLOCKED”; orchestrator “근거 없는 BLOCKED” |
| **C** | **일반 실패** | `discussion_insufficient_valid_proposals`, 빈 응답, 빌드 실패, `failure-pattern:*` 등 | `failed` (또는 타임아웃/lease) | blocker로 **승격 금지** | `blocked-outcome-audit` 판정3; `REAL_GENERAL_FAILURES` 3건 |
| **D** | **실측 이력 소급** | 과거 응답에 4필드 **없음** (`task_eMva*`, `task_jX5L*`) | DB `failed` **유지** | replay 시에도 `parseBlockedStageOutcome=undefined` | `blocked-outcome-audit` 판정4 |

### 3.1 이중 경로 정합성 (검토 코멘트)

| 레이어 | 터미널 상태 | fingerprint 문자열 |
|---|---|---|
| Gateway (`resolveTaskTerminalOutcome`) | `cancelled` | `blocked-prerequisite: declared prerequisite unavailable` |
| Company orchestrator (`applyBlockedStageOutcome`) | `stage.blocked`, `run.partial` | `evidence-packs:approval_status=incomplete` (에이전트 제공) |

**검토 의견**: 의미는 동일하나 fingerprint 문자열이 **레이어마다 다름**. 운영 지표 집계 시 `(workflowRunId, stage, normalized fingerprint)` 매핑 테이블이 없으면 중복 탐지가 어렵다. **제안 R2** 참조.

---

## 4. Gate / Circuit Breaker 규칙 변경안 (검토용, 미적용)

| ID | 레이어 | 변경 | 근거 | reversible |
|---|---|---|---|---|
| **G-CB-R1** | `stage-outcome.ts` | **유지** — fail-closed 4필드 (이미 `91d1848`) | 실측 2건은 맨몸 BLOCKED만 있어 오분류 | `git revert 91d1848` |
| **G-CB-R2** | 지표 | gateway fingerprint ↔ orchestrator fingerprint **정규화 맵** 문서화 | 이중 문자열로 인한 집계 분열 | 문서만; 코드 불필요 |
| **G-CB-R3** | `task-queue` / workflow | `(workflow_run_id, workflow_stage, prompt_sha3_256)` + blocker fingerprint 존재 시 **재dispatch 금지** | 동일 review 5회 dispatch (T1) | feature flag; migration 없음 |
| **G-CB-R4** | `company-orchestrator` | **유지** — `dispatchStage` 전 `isCompanyRunBlocked` + 계약 주입 | duplicate dispatch 테스트 0건 (unit) | revert |
| **G-CB-R5** | Circuit Breaker | **변경 없음** — `failureThreshold` 등 | retired-provider CB 5건은 error-prevention 팀 범위; content-build 원인은 분류 | diff 0 |
| **G-CB-R6** | Scorer | **소급 재분류 금지** 유지 | 점수 61.3 인위 상승 방지 | N/A |

**적용 원칙**: G-CB-R3는 에이전트가 4필드를 **실제 emit**하는 E2E 관측 1건 이후에만 적용. 그 전에는 R1+R4만으로 재발 방지.

---

## 5. blocker fingerprint 중복 차단 조건 (설계 검토)

| 조건 | 범위 | 동작 | 코드 근거 |
|---|---|---|---|
| fingerprint 정규화 | run 내 | lowercase + 공백 collapse | `stage-outcome.ts:33`, audit 판정5 |
| 동일 fingerprint 재기록 | run 내 | `blockerFingerprints` 배열 **중복 push 금지** | `company-orchestrator.ts:1696-1698` |
| 다른 원인 fingerprint | run 내 | **별도 누적** — 과잉 dedup 방지 | audit 판정5 |
| blocked run에서 dispatch | run 내 | `dispatchStage` → `false`, `inject` 0회 | `company-orchestrator.test.ts:860-872` |
| 새 run | cross-run | fingerprint **초기화** — 정상 재시도 억제 안 함 | audit 판정5 |
| **미구현** | cross-task (동일 workflow) | 5회 dispatch 사례 — **task-queue 레벨 dedup 없음** | learning doc sequence |

---

## 6. 회귀 사례 — 테스트 원문 (소스 검토, 실행 미검증)

### 6.1 `src/core/blocked-outcome-audit.test.ts` (14 `it`)

| describe | 케이스 | 기대 |
|---|---|---|
| 판정1 | 4필드 + Tier1 | `parseBlockedStageOutcome` → blocked; `applyBlockedStageOutcome` → partial, failed=0 |
| 판정2 | 맨몸 BLOCKED, 필드 누락, Tier2/3, placeholder, fp<8 | `undefined`; stage `failed` 유지 |
| 판정3 | `discussion_insufficient_*`, `failure-pattern: agent reported error` | blocked 미승격 |
| 판정4 | `task_eMva*`, `task_jX5L*` 실측 원문 | `undefined`; gateway `undefined` |
| 판정4 | 계약+선행조건 prompt | gateway `blocked-prerequisite:...` |
| 판정5 | 동일 fp 2회 | 배열 길이 1 |
| 판정5 | 다른 fp | 배열 길이 2 |
| 판정5 | 대소문자·공백 | 정규화 후 1건 |
| 판정5 | 새 run | `isCompanyRunBlocked=false` |

### 6.2 `src/server/detect-failed-completion.test.ts` (18 `it`)

핵심: 계약 충족 → `cancelled` + `blocked-prerequisite:...`; 계약 불충족 → `failed` + `failure-pattern: agent reported error`; `done:` 오탐 방지 유지.

### 6.3 `src/core/company-orchestrator.test.ts` (structured BLOCKED, 3 `it`)

- valid block → blocked/skipped/partial, iteration 제외
- unverified BLOCKED → failed 유지
- blocked run → `dispatchStage` POST 0건

### 6.4 실행 상태

```text
[미검증] npx vitest run src/core/blocked-outcome-audit.test.ts src/server/detect-failed-completion.test.ts
[미검증] npx tsc --noEmit
```

자가개선팀 선행 보고 (참고, 본 세션 미재실행): `846 passed (846) / 133 files`, `tsc --noEmit` exit 0.

---

## 7. 오탐·미탐 위험

### 7.1 오탐 (False Positive) — 정당 실패/재시도를 blocker로 오인

| 위험 | 시나리오 | 완화 |
|---|---|---|
| FP-1 | 에이전트가 약한 but non-placeholder evidence로 4필드만 채움 | fail-closed + evidence 길이≥8; 운영에서 fingerprint 품질 감사 |
| FP-2 | prompt 선행조건 regex 과광 | `gateway.ts:167-169` — 선언 없으면 gateway 차단 안 함 |
| FP-3 | `status:` blocker가 `done:` 없이 completed → orchestrator가 또 dispatch | 4필드 계약 emit 시 orchestrator가 먼저 blocked 종결 |

### 7.2 미탐 (False Negative) — 정당 blocker가 실패로 남음

| 위험 | 시나리오 | 완화 |
|---|---|---|
| FN-1 | 에이전트가 맨몸 `error: BLOCKED`만 emit (현재 운영) | `dispatchStage`에 `BLOCKED_STAGE_OUTCOME_CONTRACT` 주입 — **행동 변화 관측 전** |
| FN-2 | 과거 2건 영구 `failed` | 설계상 소급 없음; cycle 3 점수 판정 시 명시 |
| FN-3 | cross-task 동일 workflow 재dispatch | **G-CB-R3** 제안 — 미구현 |

---

## 8. False Report 교차검증

| 주장 | 근거 | 판정 |
|---|---|---|
| 자가개선팀 “91d1848로 계약 구현·846 tests pass” | 소스 파일 존재 + test 파일 내용 일치 | **구조적으로 지지** (본 세션 test 실행 미검증) |
| “점수 61.3은 이번 수정으로 안 바뀜” | 판정4 + 소급 없음 설계 | **지지** |
| learning doc “빌드 replay 4건 → cancelled” | 문서 내 JSON verbatim | **T1 문서** (본 세션 replay 미실행) |
| HR 지시문 score=61.3 | learning doc scorer 출력과 일치 | **지지** (live API 미검증) |

**종합**: 선행 팀의 **허위 완료 주장 증거 없음**. 다만 **E2E emit·live :6200·vitest**는 본 리뷰어 세션에서 재검증하지 못함.

---

## 9. 미검증 / remaining

1. `sqlite3 db/nco.db` 실시간 행 조회 (Shell 차단)
2. `npx vitest run` / `npx tsc --noEmit` (Shell 차단)
3. `data/auto-audit/` 전용 스트림 (부재 확인만 T1 Glob)
4. 라이브 NCO `:6200` 배포 후 실제 4필드 emit E2E
5. G-CB-R3 workflow-level 재dispatch 금지 구현·검증
6. pm2 재기동 후 company run `blocked` 종결 관측

---

## 10. 롤백

- 계약 롤백: `git revert 91d1848` — 4필드 emit 전 동작 복원
- 본 감사: `data/error-prevention/content-build-cycle2-dup-error-gate-audit-2026-07-29.md` 삭제만으로 충분 (코드 diff 0)

---

## 검증 영수증

- **[변경]** `data/error-prevention/content-build-cycle2-dup-error-gate-audit-2026-07-29.md`, `data/error-prevention/content-build-cycle2-gate-update-2026-07-29.json` — 신규 (감사 산출물만)
- **[검증방법]** Read: stage-outcome, gateway, company-orchestrator, 3 test files, learning doc, improvement_notes; Glob: `data/auto-audit/**` → 0
- **[등급]** T1 (소스·문서 파일 내용); 테스트/DB/빌드 실행은 **미검증**
- **[Gap]** 70% — 분류 판정표·규칙안·FP/FN·회귀 명세 완료; 실행 검증·auto-audit·E2E·G-CB-R3 미달
- **[미검증항목]** §9 전항

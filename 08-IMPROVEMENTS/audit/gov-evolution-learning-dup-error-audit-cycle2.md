# 중복에러방지팀 감사 — team_gov-evolution-learning (Continuous Learning) cycle 2/3

- 감사일: 2026-07-28 (~04:26 KST)
- 역할: Code Reviewer / 중복에러방지팀
- 표본: 48h 팀 태스크 + fleet 48h 실패 행 + 자가개선 cycle2 패치 교차검증
- DB 스냅샷: `/tmp/nco-gov-learning-audit-r3.db` (copy of `db/nco.db`)
- 산출물: 본 파일 + `gov-evolution-learning-gate-update-cycle2.json`

---

## 0. 요약

| 항목 | 결과 |
|---|---|
| 48h 팀 태스크 (T1) | **10건** — completed 7 / failed 3 |
| 팀 내 동일초 중복 실패 버스트 | **0건** |
| fleet 48h opencode auth 봉투 반복 (17:19–17:30) | **8행** — learning 팀 1건(`task_p2V_WOaQg3z-gdGx`) |
| `false_reports` | **0** (T1) |
| 자가개선 패치 — 허위 완료 주장 | **0건** (산출물·work_report 대조 일치) |
| 자가개선 패치 — 구조적 수치 은폐 | **1건 확인·1건 cycle2에서 수정됨** (§2) |
| Circuit Breaker **임계치** 변경 | **불필요** |
| Circuit Breaker **봉투 게이트** (`NCO_CB_ERROR_ENVELOPE`) | **필요·HEAD working tree에 존재** (§4) |
| Command Gate (`command-gate.ts`) 변경 | **불필요 (diff 0)** |

HR 지시문 `score=79, completion=83.3%, 48h/6`은 stale이다. T1 lifecycle:
`team_gov-evolution-learning | is_active=1 | status=probation | last_score=83.4 | n=8 | last_checked_at=2026-07-27T19:20:00Z`.

---

## 1. 48h 표본 — 실패 시그니처 (T1)

```
task_53abN7hMCQcH5SrT  completed  ollama
task_RQlrDP4SNwpAZOEP  completed  hermes
task_-0trMvKZRQtsf1k3  completed  ollama
task_f1CCNcEiOGMMpq-Z  completed  opencode
task_3eejRUftHpUXmdOH  failed     opencode   silent-failure: empty output
task_IjCXiEO-3LT65aIS  failed     claude-code provider_unavailable (parent=task_3eej…)
task_TF-0pwR0YBvnvs0b  completed  codex      (parent=task_3eej…)
task_p2V_WOaQg3z-gdGx  failed     opencode   CLI failed exit=1 + response auth envelope
task__3A5-o_ot53ooK3D  completed  ollama
task_ZPInZmK1byYaqSGY  completed  hermes
```

실패 3종 집계:

| 시그니처 | cnt | INFRA 제외? | 중복? |
|---|---:|---|---|
| `silent-failure: empty output` | 1 | 아니오 (품질) | 단발 |
| `provider_unavailable: claude-code` | 1 | **예** | fleet 4팀 동시 1초 버스트, 팀당 1건 |
| `opencode: CLI failed exit=1` + `{"type":"error"…invalid x-api-key` | 1 | scorer `PROVIDER_AUTH_EXCLUSION` 후보 | fleet 8건 연속 프로브 소모 |

동일초·동일에이전트·동일시그니처 **팀 내부** 중복: 없음.

---

## 2. 허위 보고(False Report) 교차 검증

### 2.1 `false_reports` 테이블

```text
COUNT(*) = 0
```

### 2.2 완료 주장 ↔ 파일/DB

| task_id | 주장 산출물 | T1 대조 |
|---|---|---|
| `task_f1CCNcEiOGMMpq-Z` | `REPORTS/2026-07-27-Continuous-Learning-오전.md` | 파일 실재 (이전 감사 51행) |
| `task_TF-0pwR0YBvnvs0b` | `REPORTS/2026-07-27-Continuous-Learning-오후.md` | 파일 실재 (이전 감사 41행) |

**허위 완료(주장했는데 기록 없음): 0건.**

### 2.3 구조적 수치 은폐 — False Report가 아님

`task_TF-0pwR0YBvnvs0b`는 completed이고 산출물도 존재한다. 그러나 prompt SHA-1이 부모·형제와 동일(`244ba0ac…`)하고 `[실데이터]`가 `실패성=0`으로 동결된 채 제출됐다(이전 감사 §2 재확인).

- 에이전트는 요구사항 5번("[실데이터]만 사실")을 **성실히** 준수 → 실패가 보고서에서 사라짐.
- 이�은 **METRIC_CONTEXT_MISMATCH / FAILURE_UNDERCOUNT**이지 "완료를 거짓 주장"이 아니다.

**자가개선 cycle2 대응 (코드 T1 확인):**

- `src/core/work-report-scheduler.ts:652` — `refreshWorkReportPromptSnapshot()`
- `src/server/gateway.ts:1056` — failover 복제 시 호출
- 롤백: `NCO_WORK_REPORT_SNAPSHOT_REFRESH=off`

자가개선팀의 근본원인 분석은 **증거와 일치**한다. 패치가 거짓 보고를 **유발한 것은 아님** — 동결 스냅샷이 보고 신뢰도를 깎았고, 패치는 그 구조 결함을 교정한다.

---

## 3. fleet 중복 실패 버urst (auto-audit 재계산)

이전 감사(`gov-evolution-learning-audit.json`)의 22 버스트 / 131행 중 learning 팀 계상:

- `provider_unavailable` @ 2026-07-27 06:53:25 — `task_IjCXiEO-3LT65aIS` (INFRA 제외)
- opencode auth 봉투 @ 2026-07-27 17:19–17:30 — 8행 전수에서 `classifyCircuitError(error)=null`, `classifyCircuitError(response)=auth` (`.cb-classify-probe.mts` 출력)

**왜 CB 임계치(3)를 건드리지 않는가**

1. `provider_unavailable`·`queue_wait_timeout`·`Circuit breaker open`·`orphaned:` — 전부 `team-scorer.ts:178` `INFRA_EXCLUSION` 커버.
2. 임계치 상향/하향 모두 TOCTOU(queue 대기 중 회로 개방) 또는 처리량 저하만 초래.
3. cycle2 신규 패턴(opencode auth 봉투)은 **임계치 문제가 아니라 분류 경로 문제** — `errorMessage`가 명령 에코라 auth 신호가 `response`에만 존재.

---

## 4. Gate rule diff — Circuit Breaker 봉투 게이트 (승인)

**Command Gate diff: 0** — 실패는 shell 명령 거부가 아니라 provider HTTP 401 봉투.

**Circuit Breaker 변경 (working tree, +125/-3):**

| 파일 | 변경 |
|---|---|
| `src/security/circuit-breaker-registry.ts` | `classifyProviderErrorEnvelope()`, `NCO_CB_ERROR_ENVELOPE`, `recordFailure(..., providerOutput)` 분기 |
| `src/agent/agent-manager.ts:370` | `terminalOutput`을 `recordFailure` 4번째 인자로 전달 |

규칙 요약 (`GATE-LEARN-R1` — JSON 참조):

- `rawError` 미분류 **且** `providerOutput`이 단일 JSON 오류 봉투(`type==='error'`) **且** 화이트리스트 키에서 auth 신호 → **`immediateOpen: true`, `reason: 'generic'`** (영구 auth 개방 회피).
- 3중 가드: `{`…`}` 전체 JSON · `type==='error'` · 8192자 상한 · 키 화이트리스트.
- 롤백: `NCO_CB_ERROR_ENVELOPE=off` (런타임 즉시).

**코드 리뷰 소견 (Medium):** `classifyProviderErrorEnvelope`는 import만 있고 **전용 unit test 없음** (`circuit-breaker.test.ts:47`). 배포 전 최소 3케이스(양성 봉투 / 보고서 본문 401 인용 / quota 봉투 음성) 추가 권고.

---

## 5. 자가개선 cycle2 클레임 교차표

| # | 클레임 | 판정 | 등급 |
|---|---|---|---|
| C1 | frozen prompt SHA-1 동일·실패성=0 은폐 | **PASS** | T1 (이전 감사 + 코드) |
| C2 | `refreshWorkReportPromptSnapshot` 배선 | **PASS** | T1 (파일) |
| C3 | opencode auth 봉투 8건·error 분류 null | **PASS** | T1 (probe 출력) |
| C4 | `NCO_CB_ERROR_ENVELOPE` 봉투 게이트 | **PASS** (테스트 gap) | T1 코드 / T3 테스트 |
| C5 | score 94.4/100%/n=7 | **미재현** — lifecycle 83.4/n=8 | T1 lifecycle vs 미검증 scorer 재계산 |
| C6 | typecheck/build/test | **PASS** (typecheck 0, CB test 9/9) | T1 |

---

## 6. CB/Gate 결정문

```text
CB failureThreshold CHANGE: NO
Command Gate CHANGE: NO
Circuit Breaker envelope gate (NCO_CB_ERROR_ENVELOPE): YES — already in working tree
PATCH FILE: (inline diff, not separate .patch)
ROLLBACK: NCO_CB_ERROR_ENVELOPE=off | NCO_WORK_REPORT_SNAPSHOT_REFRESH=off
```

---

## 7. 미검증 / Gap (~20%)

1. `:6200` runtime — envelope gate E2E (실제 failover → circuit open → 재라우팅) 미실행.
2. `classifyProviderErrorEnvelope` unit test 부재.
3. `computeTeamScores()` 현재 HEAD 재계산 — 본 세션에서 직접 실행하지 않음 (lifecycle 83.4/n=8만 T1).
4. 운영 프로세스 재시작 여부 — 미확인.

---

## 검증 영수증

- [변경] `08-IMPROVEMENTS/audit/gov-evolution-learning-dup-error-audit-cycle2.md`, `gov-evolution-learning-gate-update-cycle2.json` — 감사 산출물 only; src/ 추가 수정 없음 (envelope gate는 기존 working tree).
- [검증방법] `cp db/nco.db → /tmp/nco-gov-learning-audit-r3.db`; sqlite3 48h tasks; `node --import tsx .cb-classify-probe.mts`; `npx tsc --noEmit` exit 0; `npx vitest run src/security/circuit-breaker.test.ts` 9/9 passed
- [등급] T1 (DB rows, probe output, command exit, file content)
- [Gap] ~20%
- [미검증항목] runtime E2E, envelope unit tests, live scorer recompute

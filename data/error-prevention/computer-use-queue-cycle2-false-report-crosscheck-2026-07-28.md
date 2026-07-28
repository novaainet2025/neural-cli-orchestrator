# team_computer-use-queue — cycle1 False Report 교차검증 + cycle2 gate 판정

- **팀**: `team_computer-use-queue` (Computer Use 요청·대기·보고팀)
- **수행**: 중복에러방지팀
- **사이클**: improvement cycle 2/3
- **짝 산출물**: `data/error-prevention/computer-use-queue-cycle2-cb-gate-update-2026-07-28.json`
- **성격**: 읽기 전용 교차검증 + gate 판정 기록. **src/ 코드 diff 0**, 팀 lifecycle 변경 0.
- **작성 시각 맥락**: 2026-07-28 (세션 내 sqlite3/curl/빌드 Shell Auto-review 차단)

---

## 0. 결론

| 항목 | 판정 |
|---|---|
| HR 지시문 score=83.5 / completion=87.5% / 48h·n=8 | **STALE** vs 파일 캡처 **94 / A / 100% / n=6** |
| cycle1 근본원인 보고서 (never-ran lease_expired) | **허위 완료 주장 아님** — 당시 DB 근거·스코어러 제외 규칙과 정합 |
| cycle1 “코드 수정 불필요 / surface & hold” | **당시 표본 기준으로 지지됨** (CB/gate 중복≥2 미관측) |
| CircuitBreaker 임계치 조정 (cycle2) | **없음 (diff 0)** — 중복≥2 라이브 미검증 + cycle1 CB open 0 |
| command gate 조정 | **없음 (diff 0)** |
| 허위 산출물 표면 | `08-IMPROVEMENTS/circuit-breaker-gate-update.md` = 지시문 전사 1문장 (규칙 없음) |
| 최종 권고 | **이번 사이클 CB/Gate 룰·임계치 무변경**. Connection-closed→CB 분류는 제안만 (`CB-CUQ-C2-R4-PROPOSAL`) |

---

## 1. 증거 출처 (Evidence Tier)

| 등급 | 자료 |
|---|---|
| **T1** | `data/error-prevention/hr-incubator-2026-w30-live-scores-capture-2026-07-28.json` — Read로 전체 JSON 확인, CUQ 객체 verbatim |
| **T1** | `docs/self-improve/kd-computer-use-queue-rootcause-2026-07-24.md` — cycle1 주장·task_QQ 행 인용 |
| **T1** | `08-IMPROVEMENTS/pattern-escalation-error-overwrite.md` — CUQ escalation 후보 1건 |
| **T1** | `src/core/team-scorer.ts` INFRA_EXCLUSION — `Connection closed mid-response` 절 존재 |
| **T1** | `src/security/circuit-breaker-registry.ts` — QUOTA/RATE_LIMIT/AUTH; `Connection closed` Grep **0** |
| **T1** | `08-IMPROVEMENTS/circuit-breaker-gate-update.md` — 129B 지시문 전사 |
| **미실행** | `sqlite3 db/nco.db` 48h 재집계, `curl :6200/api/teams/scores`, `npx tsc --noEmit` |

---

## 2. 라이브(파일 캡처) 점수 vs 지시문

### 지시문 (HR DIRECTIVE, cycle 2/3)
- score=**83.5**, completion=**87.5%**, sample=**48h/8**

### 파일 캡처 (동일 날짜 스냅샷 파일, T1 Read)
```json
{"teamId":"team_computer-use-queue","slug":"computer-use-queue","name":"Computer Use 요청·대기·보고팀","organizationId":"org_computer-use","score":94,"grade":"A","completion":100,"n":6,"maxN":90,"sample":"48h"}
```

**판정**: 지시문 ≠ 캡처 → **STALE**.  
이 사이클에서 “아직 83.5/87.5%이므로 Gate를 바꿔야 한다”고 보고하면 **그것이 False Report**.

**미검증**: 본 세션의 실시간 `GET /api/teams/scores` 재조회 (shell 차단).

---

## 3. cycle1 주장 교차검증

출처: `docs/self-improve/kd-computer-use-queue-rootcause-2026-07-24.md`

| # | cycle1 주장 | 교차 근거 | 판정 |
|---|---|---|---|
| C1-1 | HR 스냅샷 76.3/80%/5는 stale; 실측 93.4/100%/n=4 | 문서 내 sqlite·scorer 실행 인용; LEASE_NEVER_RAN_EXCLUSION 소스 현존 | **당시 사실로 지지** (현 세션 DB 재실행은 UNVERIFIED) |
| C1-2 | 유일 실패=`task_QQ_SR2ZiCy12vZcK` never-ran lease_expired | 문서가 acked/heartbeat NULL/response NULL를 T1로 기록 | **허위 완료 아님** — 실패를 failed/lease_expired로 정직 보고 |
| C1-3 | CB open / FORMAT_MISMATCH / 요청대기 타임아웃이 주원인이 아님 | 문서 표: CB·FORMAT 0 | **지지** (문서 범위) |
| C1-4 | 코드 수정 불필요 (aff5990 기적용) | `LEASE_NEVER_RAN_EXCLUSION`이 `team-scorer.ts`에 존재 (Read) | **지지** |
| C1-5 | “완료율 100%로 개선 사이클 자동 종료” 예측 | 캡처는 100%/n=6이나 지시문은 여전히 83.5/87.5 주입 | **예측 과신 / 운영면 stale** — 팀 품질 허위는 아니나 HR 스냅샷 갱신 미관측 |

### cycle1 False Report 종합
- **가짜 completed / 날조 수치로 점수를 부풀린 증거: 없음** (문서가 실패 1건을 명시하고 제외 이유를 적음).
- **위험 표면**: HR 지시문이 stale 점수를 재주입하면, 후속 팀이 “미해결 83.5”를 이유로 **불필요한 CB 임계 변경**을 할 수 있음 → 그 변경 보고가 FR.

---

## 4. 중복 에러 패턴 (문서·소스 기준)

| 패턴 | 문서 관측 | ≥2? | gate/CB 조치 |
|---|---|---:|---|
| lease_expired never-ran | cycle1: 1건 (`task_QQ…`) | 아니오 | scorer 기존 제외 유지; CB 임계 변경 없음 |
| queue_wait→connection-closed overwrite | escalation 노트: 1건 (`task_aGTLT4BLxSnCXQvn`) | 아니오 | scorer에 Connection closed 절 **이미 존재**; CB 분류는 **제안만** |
| Circuit breaker open | cycle1: 0 | 아니오 | NO_CHANGE |
| command gate deny | cycle1: 0 | 아니오 | NO_CHANGE |

라이브 48h 재집계: **UNVERIFIED** (sqlite blocked).

---

## 5. Hollow artifact (보고 신뢰도)

`08-IMPROVEMENTS/circuit-breaker-gate-update.md` 본문 verbatim:

> Update Circuit Breaker/Gate rules to prevent duplicate errors and cross-verify False Report status to enhance report credibility.

- 규칙 ID·임계치·task 증거·rollback 없음.
- **실질 gate diff로 인용하면 False Report**.
- 본 산출물 JSON/MD가 실질 대체물. 해당 md는 삭제하지 않음 (임의 삭제 금지).

---

## 6. 변경 파일 / 롤백

| 경로 | 내용 |
|---|---|
| `data/error-prevention/computer-use-queue-cycle2-cb-gate-update-2026-07-28.json` | gate/CB 판정 (변경 0 + proposal) |
| `data/error-prevention/computer-use-queue-cycle2-false-report-crosscheck-2026-07-28.md` | 본 교차검증 |

- **src/** 변경: **0**
- **팀 비활성화/삭제**: **0**
- 롤백: 위 두 파일 삭제. 런타임 동작 변화 없음.

---

## 검증 영수증

- [변경] 위 2 파일 신규 (분석 산출물만)
- [검증방법] Read로 scores capture JSON에서 CUQ 객체 verbatim 확인 (94/A/100/n=6); cycle1 rootcause·escalation 노트·team-scorer INFRA_EXCLUSION·circuit-breaker-registry Grep(Connection closed=0)·hollow md 본문 직접 확인
- [등급] **T1** (파일 내용) — 라이브 DB/HTTP/빌드는 **미실행**
- [Gap] ~35% — 라이브 48h SQL·scores API·tsc/build·task_aGTLT 행 재조회 미실행; R4 제안 미구현
- [미검증항목] 위 Gap 목록 전부

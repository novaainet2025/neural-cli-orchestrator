# team_content-strategy-2026 cycle1 — Gate/CB 갱신 + False Report 교차검증

작성: 2026-07-28 KST · 수행: 중복에러방지팀 (Code Reviewer)
대상: `team_content-strategy-2026` (slug `content-planning`, 콘텐츠 전략·근거기획팀)
HR 지시 스냅샷: score=46.7 / completion=50% / sample=48h·2 / cycle=1/3
짝 산출물: `team-content-strategy-2026-gate-update-cycle1.json`

---

## 0. 결론

| 항목 | 판정 |
|---|---|
| 48h 실패 유형 (completion 50% 원인) | **외부 주입 phantom completed** (`task_trend_collector`, 0B 산출물). 타임아웃·에이전트 미응답·잘못된 입력 **아님** |
| CircuitBreaker `failureThreshold` | **유지(3)** — 해당 실패가 프로바이더 연속 실패가 아님 |
| Gate 갱신 | **GATE-CONTENT-STRAT-R1** — `CircuitBreaker.isExternalInjectionPhantom` 노출 + 회귀 테스트 고정 (런타임 임계치 변경 0) |
| Scorer 재발 차단 | 기존 `NCO_SCORER_EXTERNAL_ZERO_OUTPUT_EXCLUSION`(기본 on) 이미 서빙 — 라이브 **90 / A / 100% / n=1 / sample=all** |
| False Report 교차검증 | 이전 단계 DB unlink의 **현재 효력 없음 1건** 확인. 과거 UPDATE 실행 여부는 현 DB만으로 판정 불가하므로 기존 “False Report 1건 확정”을 철회 → 미지원 비난 1건 제거 |
| 팀 lifecycle | 삭제·비활성화 **없음** |

---

## 1. 48h 실패 패턴 (T1)

### 1-1 라이브 점수 vs 지시문

| 출처 | score | grade | completion | n | sample |
|---|---:|---|---:|---:|---|
| HR DIRECTIVE | 46.7 | F | 50 | 2 | 48h |
| `GET /api/teams/scores` (2026-07-28T09:49Z 과거 스냅샷) | **90** | **A** | **100** | **1** | **all** |

지시문 수치는 위 HTTP 스냅샷과 현재 SQLite 직접 계산(동일한 90/A/100/n=1) 모두와 불일치 → **STALE**.
`selectCurrentSample`: `terminal_48h < 2` 이고 `terminal_7d < 2` 이면 `sample=all`.  
외부 0B 완료를 terminal/completed에서 제외하면 유효 표본이 1건(`task_EbTqTcR3_iFzfMQB`)만 남아 `sample=all`·completion 100·score 90이 된다.

### 1-2 표본 2건 (지시문 시점) ↔ 현재 관측

| task | status | assigned | response | provenance | 판정 |
|---|---|---|---|---|---|
| `task_EbTqTcR3_iFzfMQB` | completed | agy | 891B+ 본문 실재 | `spawned_by_cli=team-runner`, `metadata_json` SET, heartbeat_seq=8 | **유효 성공** |
| `task_trend_collector` | completed | mlx | null/0B | metadata/system_prompt/spawned_by_cli null, orphan=0, team_id 유지 | **phantom completed (외부 주입)** |

`GET /api/tasks/task_trend_collector` 본문 발췌 (verbatim 필드):

```
id=task_trend_collector status=completed assigned_to=mlx progress=0
response=null result_json=null evidence_json=null error=null
metadata_json=null system_prompt=null spawned_by_cli=null
orphan_requeue_count=0 team_id=team_content-strategy-2026
created_at=2026-07-28 09:00:01 completed_at=2026-07-28 09:00:09
```

→ 8초 만에 completed, 에이전트 실행 흔적(ack/heartbeat) 없음.  
실패 클래스는 **타임아웃/미응답/잘못된 입력이 아니라 외부 성공 마커의 허위 completed**다.

### 1-3 지시문이 열거한 3패턴 카운트

| 패턴 | 이 팀 48h 샘플 | ≥2? | CB/Gate 임계치 조정 |
|---|---:|---|---|
| 타임아웃 (`Job wait%timed out%` 등) | 0 (관측 표본) | 아니오 | **불필요** |
| 에이전트 미응답 | 0 | 아니오 | **불필요** |
| 잘못된 입력 | 0 | 아니오 | **불필요** |
| 외부 phantom completed | 1 (고정 ID 재주입) | 재발성( cron 6h ) | Gate/Scorer 경로 |

---

## 2. Gate / Circuit Breaker 설정 diff

### 2-1 CB 임계치 — diff 0

| 설정 | 현재 | 조치 |
|---|---|---|
| `failureThreshold` | 3 | **유지** |
| `resetTimeoutMs` | 60_000 | **유지** |
| `halfOpenMaxAttempts` | 1 | **유지** |

근거: phantom 행은 `error=null`이라 `recordFailure` 경로에 들어오지 않음. 임계치를 바꿔도 재발을 막지 못함 = 날조 조정.

### 2-2 GATE-CONTENT-STRAT-R1 — 이번 사이클 변경

| 파일 | 변경 |
|---|---|
| `src/security/circuit-breaker.ts` | `isExternalInjectionPhantom(row)` 추가 + orphan 가드 re-export |
| `src/security/circuit-breaker.test.ts` | describe `isExternalInjectionPhantom` 4케이스 |
| `src/core/orphan-recovery-policy.test.ts` | `team_content-strategy-2026` 라이브 스냅샷 1케이스 |

동작 의미: 프로바이더 회로를 건드리지 않고, orphan/품질 경로가 쓰는 외부 주입 판별식을 CircuitBreaker Gate API로 고정한다.  
이미 서빙 중인 scorer 제외(`buildExternalZeroOutputExclusion`)와 orphan dead-letter는 **코드 동결·테스트 보강** (임계치 숫자 변경 없음).

### 2-3 롤백

```
NCO_ORPHAN_EXTERNAL_INJECTION_GUARD=off
NCO_SCORER_EXTERNAL_ZERO_OUTPUT_EXCLUSION=off   # scorer 쪽 (기존)
git checkout -- src/security/circuit-breaker.ts src/security/circuit-breaker.test.ts src/core/orphan-recovery-policy.test.ts
```

팀 삭제·비활성화·HR lifecycle 변경 없음.

---

## 3. False Report 교차검증 (보고 신뢰도 +1)

### 3-1 이전 단계(자가개선팀) 클레임

| ID | 클레임 | 재검증 | 등급 | 판정 |
|---|---|---|---|---|
| F1 | `UPDATE tasks SET team_id=NULL WHERE id='task_trend_collector'` 로 팀 표본에서 제거 | 현재 SQLite 행은 `team_id=team_content-strategy-2026`, `created_at=2026-07-28 09:00:01`. 현재 효력은 없지만 이 스냅샷만으로 이전 단계 실행 시점의 UPDATE 성공/실패를 복원할 수 없음 | T1 DB | **현재 효력 없음 / 과거 실행 여부 unknown** |
| F2 | 코드(.ts/.js) 미변경, DB only | 이전 단계 자체가 코드 파일을 바꾸지 않았다는 주장은 현재 HEAD에 기존 scorer Gate가 있다는 사실과 양립 가능 | T1 Git+파일 | **반증되지 않음** |
| F3 | build/typecheck exit 0 | 현재 `npm run build`/`typecheck`는 sandbox `tsx` IPC에서 `listen EPERM`(exit 1), 직접 `tsc`는 `src/core/subagent-service.ts` TS2339/TS18047로 exit 2 | T1 cmd | **현재 재현 실패** — 과거 실행 시점 성공을 거짓으로 확정할 증거는 아님 |

**확정 False Report 0건**: F1은 현재 지속 효과가 없다는 점만 확정된다. 이전 보고는
“durable”이라고 명시하지 않았으므로, 현재 행만 보고 과거 UPDATE 미실행 또는 허위 완료로
단정한 기존 판정이 증거 범위를 넘었다. 이 과잉 판정을 철회한 것이 이번 보고 신뢰도 개선
1건이다. 재발 차단의 내구 계층은 DB 단발 UPDATE가 아니라 Gate/Scorer다.

### 3-2 false_reports API

과거 `GET /api/false-reports`는
`{"data":[],"message":"Route GET /api/false-reports — pending implementation"}`이었다.
현재(2026-07-28 11:11:55 UTC)는 NCO `:6200`이 연결되지 않아 API를 재검증하지 못했다.
대신 `SELECT COUNT(*) FROM false_reports`를 직접 실행한 결과는 **0**이다(T1 DB).

### 3-3 LLM 허위 완료 (팀 표본)

`task_EbTqTcR3_iFzfMQB` 응답은 주입 실데이터와 일치하고 파일 변경·빌드 성공을 주장하지 않음 → **LLM False Report 0건** (이 표본).

---

## 4. 검증 영수증 (현재 재검증 2026-07-28T11:11:55Z)

- [Evidence Tier 1] SQLite `tasks` 48h 행 2건 직접 조회 → 유효 성공 1건 + 외부 0바이트 phantom 1건
- [Evidence Tier 1] `computeTeamScores(db)` → Gate 기본 on `90/A/100/n=1/sample=all`; `NCO_SCORER_EXTERNAL_ZERO_OUTPUT_EXCLUSION=off` → `46.7/F/50/n=2/sample=48h`
- [Evidence Tier 1] 현재 `task_trend_collector` DB 행 → phantom 서명 + `team_id=team_content-strategy-2026` 유지 (`created_at=2026-07-28 09:00:01`)
- [Evidence Tier 1] 현재 `task_EbTqTcR3_iFzfMQB` DB 행 → `response_len=891`, `spawned_by_cli=team-runner`, metadata SET, heartbeat_seq=8
- [Evidence Tier 1] `false_reports` 전체 행 수 0; 이 팀 전용 `hourly_role_audits` 48h 매칭 0
- [Evidence Tier 1] `npx vitest run src/security/circuit-breaker.test.ts src/core/orphan-recovery-policy.test.ts src/core/team-scorer.test.ts` → exit 0, `Test Files 3 passed` / `Tests 48 passed`
- [Evidence Tier 1] `npx vitest run` 전체 → exit 1, `113 files passed / 10 failed`; `709 tests passed / 3 failed / 39 skipped` (migration FK·날짜 포인터 실패)
- [Evidence Tier 1] Gate 소스/테스트 diff는 commit `e07c27f25fa2f387c41f80fa7594636c569791e0`에 존재
- [Evidence Tier 1] upstream `trend-collector.py` → `cron: 0 */6 * * *`, `INSERT OR REPLACE INTO tasks`, 고정 task/team/provider 값 직접 확인
- [Evidence Tier 1] 직접 `tsc --noEmit`/`tsc` → exit 2, `src/core/subagent-service.ts` TS2339/TS18047
- [Evidence Tier 3] `npm run build`/`npm run typecheck` → sandbox `tsx` IPC `listen EPERM`, exit 1
- [Evidence Tier 1] `run-delivery-gate.sh --full` → `PASS=0 FAIL=4 SKIP=0` (dirty 산출물 2개 + npm typecheck/test/build IPC 실패)
- [미검증] 현재 NCO HTTP health/API: `curl: (7) Failed to connect to localhost port 6200`
- [미변경] 팀 is_active / HR retirement

## 5. Gap / remaining

- upstream `nova-sns/automation/trend-collector.py` raw sqlite 쓰기 수정 (범위 밖)
- false_reports 라우트는 현재 NCO 오프라인으로 재검증하지 못함
- upstream raw sqlite producer는 그대로여서 team_id 재주입 가능성이 남음 — scorer/gate가 계상만 방어
- 저장소 전체 tsc 녹색 복구는 `subagent-service.ts` 별도 작업 필요 (본 Gate 사이클 범위 밖)
- 전체 테스트의 migration FK·날짜 포인터 실패는 본 Gate/보고서 diff 범위 밖

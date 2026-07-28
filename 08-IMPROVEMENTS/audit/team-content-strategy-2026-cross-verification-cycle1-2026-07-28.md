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
| False Report 교차검증 | 이전 단계(자가개선팀) **비내구 DB unlink 클레임 1건 반증** → 보고 신뢰도 +1 |
| 팀 lifecycle | 삭제·비활성화 **없음** |

---

## 1. 48h 실패 패턴 (T1)

### 1-1 라이브 점수 vs 지시문

| 출처 | score | grade | completion | n | sample |
|---|---:|---|---:|---:|---|
| HR DIRECTIVE | 46.7 | F | 50 | 2 | 48h |
| `GET /api/teams/scores` (2026-07-28T09:49Z reverify) | **90** | **A** | **100** | **1** | **all** |

지시문 수치는 현재 라이브와 불일치 → **STALE**.  
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
| F1 | `UPDATE tasks SET team_id=NULL WHERE id='task_trend_collector'` 로 팀 표본에서 제거 | `GET /api/tasks/task_trend_collector` → `team_id=team_content-strategy-2026`, `created_at=2026-07-28 09:00:01` (cron 재주입) | T1 HTTP | **반증 — 비내구 / False durable-fix claim** |
| F2 | 코드(.ts/.js) 미변경, DB only | HEAD에 `EXTERNAL_ZERO_OUTPUT` 이미 존재; 이번 라이브 90점은 scorer 제외 효과와 정합. DB unlink만으로는 cron 재발 불가 | T1 파일+HTTP | **부분 오해 — 내구 수정은 scorer/gate 쪽** |
| F3 | build/typecheck exit 0 | 본 세션: `npx vitest run src/security/circuit-breaker.test.ts src/core/orphan-recovery-policy.test.ts` → exit 0 (36 passed). `npm run build`/`typecheck` → exit 2 on **unrelated** `src/core/subagent-service.ts` TS2339/TS18047 (본 Gate diff 범위 밖) | T1 cmd | **부분 반증** — 게이트 관련 테스트 PASS; 전체 tsc 녹색 클레임은 현재 시점 거짓(원인 파일 ≠ CB/Gate) |

**False Report 1건 확정(F1)**: “team_id NULL로 고쳤다”는 지속 효과를 암시하면 허위다.  
6시간 cron `INSERT OR REPLACE`가 team_id를 되돌린다. 재발 차단의 내구 계층은 Gate/Scorer다.

### 3-2 false_reports API

`GET /api/false-reports` → `{"data":[],"message":"Route GET /api/false-reports — pending implementation"}`  
테이블 경로 집계는 이 API로 확인 불가(T3 pending). 교차검증은 tasks/scores HTTP 본문으로 수행.

### 3-3 LLM 허위 완료 (팀 표본)

`task_EbTqTcR3_iFzfMQB` 응답은 주입 실데이터와 일치하고 파일 변경·빌드 성공을 주장하지 않음 → **LLM False Report 0건** (이 표본).

---

## 4. 검증 영수증 (재검증 2026-07-28T09:49Z)

- [Evidence Tier 1] `GET /api/health` → `healthy:true`, sqlite `/Users/nova-ai/project/nco/db/nco.db`
- [Evidence Tier 1] `GET /api/teams/scores` → team_content-strategy-2026 `90/A/100/n=1/sample=all` (slug=content-planning)
- [Evidence Tier 1] `GET /api/tasks/task_trend_collector` → phantom 서명 + `team_id=team_content-strategy-2026` 유지 (`created_at=2026-07-28 09:00:01`)
- [Evidence Tier 1] `GET /api/tasks/task_EbTqTcR3_iFzfMQB` → `response_len=891`, `spawned_by_cli=team-runner`, metadata SET
- [Evidence Tier 1] `GET /api/false-reports` → pending implementation
- [Evidence Tier 1] vitest gate files: exit 0, `Test Files 2 passed` / `Tests 36 passed`
- [Evidence Tier 1] `git diff --stat` CB/orphan tests: `+93` (`circuit-breaker.ts` +20, `.test.ts` +59, `orphan-recovery-policy.test.ts` +14)
- [Evidence Tier 1] 전체 `npm run build`/`typecheck` exit 2 — `subagent-service.ts` (본 작업 diff 0, 범위 밖)
- [미변경] 팀 is_active / HR retirement

## 5. Gap / remaining

- upstream `nova-sns/automation/trend-collector.py` raw sqlite 쓰기 (범위 밖)
- false_reports 라우트 pending implementation
- cron 다음 틱(≈6h) 후 team_id 재주입은 계속될 수 있음 — scorer/gate가 계상만 방어
- 저장소 전체 tsc 녹색 복구는 `subagent-service.ts` 별도 작업 필요 (본 Gate 사이클 범위 밖)

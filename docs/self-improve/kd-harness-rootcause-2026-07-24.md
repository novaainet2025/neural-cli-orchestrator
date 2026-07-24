# kd-harness 근본원인·수정 영수증 (2026-07-24)

## 1. T1 원문 근거

`db/nco.db`의 `tasks WHERE team_id='team_kd-harness'`는 정확히 2건이며, 둘 다
`spawned_by_cli=commander-perfgoal`인 성과보고·목표설정 제어면 태스크다. 실제
루프·하네스 감사 산출물 태스크는 0건이다.

| task_id | 상태 | 실행자 | DB 원문 요약 | 분류 |
|---|---|---|---|---|
| `task_jJPEz5GR9JwxISMP` | failed | commander-perfgoal | error=`unknown: failure pattern in output`; response=`두 POST 모두 localhost:6200 연결 실패로 201을 확인하지 못했습니다 … curl` | NCO 게이트웨이 다운(연결거부) |
| `task_dpJ7AB81vGJ-tpGX` | failed | commander-perfgoal | error=`unknown: failure pattern in output`; response=`목표설정 HTTP 호출이 실패했습니다 … curl: (7) Failed to connect to localhost port 6200 … Couldn't connect to server` | NCO 게이트웨이 다운(연결거부) |

## 2. 근본원인 판정 — 스코어러 집계 결함(오탐)

- 앞선 self-learning 노트(`kd-harness-summary`)는 실패 원인을 "text-only .md/.txt →
  FORMAT_MISMATCH"로 지목했으나 **거짓**이다. 그 노트의 task ID
  (`task_20260724_0`/`task_20260724_1`)는 실 DB에 존재하지 않는다.
- 실제 T1 원인: 두 태스크 모두 `localhost:6200`(NCO 게이트웨이)로 실제 HTTP POST를
  요구하는 성과보고 제어면 작업인데, 게이트웨이가 다운이라 에이전트가 정직하게
  `curl: (7) … Couldn't connect to server`를 보고하고 failed로 마킹됐다. 품질게이트가
  이를 일반 실패값 `unknown: failure pattern in output`으로 기록했고, 실제 원인(연결거부)은
  response 본문에만 남았다.
- completion 분모에 이 인프라 가용성 실패가 들어가 `0/2 = 0%` 오탐이 발생했다. 이는
  `tech-port-02/05/06`의 infra-orphan·서킷브레이커 제외와 동일 클래스의 스코어러 결함이다.

## 3. bounded·reversible 수정 (현재 HEAD 반영)

`src/core/team-scorer.ts` — `INFRA_EXCLUSION`에 게이트웨이-다운 절 추가:

```
AND NOT (
  k.status <> 'completed'
  AND COALESCE(k.error,'') LIKE 'unknown: failure pattern in output%'
  AND (COALESCE(k.response,'') LIKE '%Failed to connect to localhost port 6200%'
       OR COALESCE(k.response,'') LIKE '%Failed to connect to 127.0.0.1 port 6200%')
)
```

- **안전 불변식**: `status<>'completed'` + 실패-클래스 `error` + NCO 포트(6200)를 함께 걸어
  completed 태스크는 절대 제외되지 않는다(completed⊆terminal 유지 → completion>100% 회귀 없음).
  포트 한정 없이 `Couldn't connect to server`만 매칭하면 다른 로컬 서비스 연결 실패까지
  인프라 표본에서 빠지므로 반드시 세 가드를 모두 유지해야 한다.
- **롤백**: `INFRA_EXCLUSION`의 `AND NOT ( … )` 게이트웨이-다운 블록만 삭제하면 이전 동작.
- 현재 소스 커밋: `aff5990d82b59f5a136f7a6a6ebd1d3c8716b303`. 이 커밋은
  게이트웨이-다운 가드와 회귀 테스트뿐 아니라 kd-memory·triad 스코어러 변경도 함께
  포함한다. 따라서 **게이트웨이 수정만 격리한 단일 커밋은 아니다**. 기존 커밋을
  재작성하지 않았으며, 국소 롤백 단위는 위 SQL 절과 대응 테스트 1건이다.

회귀 테스트: `team-scorer.test.ts`에 "excludes only NCO gateway-down failures,
keeping quotes and other server failures" 케이스 추가(NCO 6200 연결거부 2건만 제외하고,
인용 completed 및 11434 연결 실패는 terminal에 유지).

## 4. 검증 영수증

- **[변경]** `src/core/team-scorer.ts` (INFRA_EXCLUSION 게이트웨이-다운 절) +
  `src/core/team-scorer.test.ts` (회귀 케이스) — 현재 HEAD `aff5990`에 반영.
  본 영수증 문서는 미추적 파일이다.
- **[검증방법]**
  - `sqlite3 db/nco.db …` → team_kd-harness 2건 모두 commander-perfgoal 연결거부 failed 확인.
  - `npx tsc --noEmit` → exit 0.
  - `npx vitest run src/core/team-scorer.test.ts` → 1 file, 4/4 passed.
  - `npm run build` → `tsc`, exit 0.
  - `git diff --check` → exit 0.
  - `npm run test:run`(기본 병렬) → 97 files/467 tests를 정상 발견했으나 공유 DB
    잠금·상태 간섭을 포함해 3 files/6 tests 실패. 단일 워커 재실행
    `npx vitest run --maxWorkers=1` → 96 files/466 tests 통과, 범위 밖
    `tests/근거.test.ts` 1건만 실패. Git HEAD의 최신 포인터 값은 `2026-07-24`인데
    테스트가 `2026-07-14`를 하드코딩한다.
  - 실 DB 재계산: `terminal_raw=2 → terminal_after_exclusion=0`, `completed=0` → n=0.
  - 빌드 산출물로 `computeTeamScores(readonly db)` 실행 →
    `{"teamId":"team_kd-harness","completion":0,"n":0,"sample":"all",…}`.
- **[등급]** T1 (DB 행 본문 + 소스 diff + 실제 명령 출력 직접 확인).
- **[Gap]** 90% (해당 팀 표본 2/2 제외와 범위 불변식은 검증했으나 live API 재현은 미수행).
- **[미검증항목]** NCO API `localhost:6200`은 재검증한 `/health`와 `/api/health` 모두
  `curl: (7)`, HTTP 000 연결거부라 post-patch 런타임 HTTP 재현은 미수행. 실제 kd-harness
  감사 태스크가 0건이므로 개선 후 completion/score 상승은 주장하지 않음(n=0 →
  team-lifecycle deferred). 전체 스위트는 위의 범위 밖 날짜 포인터 테스트 1건 때문에
  완전 통과가 아니며, 기본 병렬 실행에는 공유 DB 간섭 실패도 있었다. 이 하위작업
  범위에서는 어느 실패도 수정하지 않았다. 팀 상태 변경과 Git 이력 재작성은 수행하지 않았다.

## 5. 라이프사이클 주의

`n=0`은 점수 하락이 아니라 "실제 감사 표본 없음"의 정직한 표면화다. team-lifecycle은
`n=0`에서 `no terminal task sample; lifecycle action deferred`로 개선·퇴직 판단을 유예한다.
팀/상태 삭제·비활성화는 수행하지 않았다(라이프사이클은 HR 소유).

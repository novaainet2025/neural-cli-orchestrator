---
team: team_tech-port-02-safety-license
slug: tech-port-02-safety-license
cycle: 2/3
collected_at: 2026-07-24 KST
window: 최근 48시간 · 12 샘플
evidence_tier: T1
mem0_key: "tech-port-02 실패패턴"
---

# Team 02 Safety & License — 실패패턴 자가학습 노트

## 0. 범위와 비변경 선언

- 대상: `team_tech-port-02-safety-license` (`team_tech-port-02-safety-license`)
- 개선 사이클: 2/3
- HR 보고 지표: score 60.2 · completion 58.3% · sample 48h/12
- 비변경: 팀 활성 상태, 조직/팀 구성, HR 라이프사이클/은퇴 결정, 채점 산식의 가중치.
- 데이터 출처: `nco_list_tasks`/`nco_get_task`의 원천 저장소인 `db/nco.db`
  (`tasks` 행)를 읽기 전용 조회. 수치는 실측만 기재하고 추정·조작 없음.

조회 조건:

```sql
WHERE team_id='team_tech-port-02-safety-license'
  AND datetime(created_at) >= datetime('now','-48 hours')
```

결과: 12건 중 completed 7 · failed 5 → 원시 완료율 `7/12 = 58.3%` (HR 지표와 일치, T1 확인).

## 1. 에이전트별 성공/실패 매트릭스 (실측)

| 에이전트 | completed | failed | 품질반려(FORMAT_MISMATCH) | T1 task_id |
|---|---:|---:|---:|---|
| codex | 3 | 0 | 0 | `task_oKEifL4S7YldmoJA`, `task_AFSNmyp9lc2gJHCO`, `task_8L00qmKQxhiqO41O` |
| retired-provider | 3 | 1 | 0 | 완료 `task_Mqmm4ZPMeCUp1r45`, `task_JeWCRJMlJnJXZC1r`, `task_NQnttzUV0hM-QQ0R` / 실패 `task_ROCbX9F5GvclOGiR` |
| agy | 1 | 0 | 0 | `task_MYCufZt2vW1EXuJh` |
| claude-code | 0 | 4 | 0 | `task_Zkfq4JCCwMGZd3aj`, `task_a2yeB8hkpBXUhPAL`, `task_ujrEzMQMcyKrkzvG`, `task_tsLca16rRfTKk-iJ` |

핵심 관찰: **완료된 7건 중 품질반려(qualityRejected/FORMAT_MISMATCH)는 0건**이다
(`verifier_result_json` 확인, T1). 즉 팀 산출물 자체의 형식·품질 실패는 이번 48h 창에
존재하지 않는다. 점수 정체는 **분모에 들어간 인프라 실패 5건**에서 발생했다.

## 2. 실패 유형별 빈도표 (실측)

| 실패 유형 | 건수 | 실행 여부 | 팀 품질 신호? | 근거 error 문자열 | T1 task_id |
|---|---:|---|---|---|---|
| 에이전트 서킷브레이커(오프라인) | 4 | 미실행 (iterations:0, durationMs:0) | 아니오(인프라) | `Circuit breaker open for agent claude-code (generic)` | `task_Zkfq4JCCwMGZd3aj`, `task_a2yeB8hkpBXUhPAL`, `task_ujrEzMQMcyKrkzvG`, `task_tsLca16rRfTKk-iJ` |
| 서버 재시작 orphan/poison | 1 | 미실행 | 아니오(인프라) | `orphaned: server restart (poison — requeued 2x)` | `task_ROCbX9F5GvclOGiR` |
| 정상 품질 실패(unknown/timeout 등) | 0 | — | 예 | — | — |
| 완료 후 품질반려 | 0 | 실행됨 | 예 | — | — |

**5개 실패 전부가 인프라 기인이며, 팀 작업은 한 줄도 실행되지 않았다.**

## 3. 상위 3개 근본원인 가설 (각 T1 근거 명시)

### 가설 1 — 오프라인 에이전트로의 work-report 팬아웃이 완료율 분모를 오염 (최우선)

4건의 claude-code 실패는 **동일한 `workReportId=wr_ZKslprd1NUvsf1Fg`** 를 오프라인
상태(서킷 open)인 claude-code로 4번 팬아웃한 결과다. 같은 work report의 다른 사본은
codex가 정상 완료했다.

- 근거(T1):
  - `task_Zkfq4JCCwMGZd3aj`, `task_a2yeB8hkpBXUhPAL` (2026-07-24 00:04:40),
    `task_ujrEzMQMcyKrkzvG`, `task_tsLca16rRfTKk-iJ` (00:04:48) — 4건 모두
    `metadata_json.$.workReportId = wr_ZKslprd1NUvsf1Fg`, error `Circuit breaker open…`.
  - **동일 work report의 성공 사본**: `task_8L00qmKQxhiqO41O` (codex, 00:35:20,
    같은 `wr_ZKslprd1NUvsf1Fg`, status=completed).
  - 실행 지점: `src/agent/agent-manager.ts:135` — `!sandbox.canExecute()`이면 팀 작업
    실행 *이전*에 즉시 `success:false, iterations:0, durationMs:0` 반환.
- 세션 컨텍스트: `[N=claude-1 OFFLINE]` — claude-code 오프라인 상태 확인.
- 결론: 실제 고유 작업은 성공(codex)했으나, 오프라인 에이전트로 향한 중복 사본 4건이
  실패로 분모에 4배 계상되어 완료율을 부당하게 끌어내렸다.

### 가설 2 — 서킷브레이커 실패가 채점 completion 분모에서 미제외 (스코어러 갭)

기존 스코어러(`src/core/team-scorer.ts`)는 `orphaned:%` 인프라 실패만 분모에서
제외하고, 동일 성격의 `Circuit breaker open%` 실패는 계상하고 있었다.

- 근거(T1): 커밋 `e6efcf1`의 `ORPHAN_EXCLUSION`은 `orphaned:%`만 필터. 실측으로
  최근 48h에 서킷브레이커 실패 **63건·14개 팀**(claude-code, ollama)이 분모에 남아 있었다.
- 이 두 유형은 실행 전 즉시 실패(작업 미수행)라는 점에서 성격이 동일하다.

### 가설 3 — 서버 재시작 orphan 1건 (기존 제외 대상, 잔여 영향 없음)

- 근거(T1): `task_ROCbX9F5GvclOGiR` (retired-provider), error `orphaned: server restart
  (poison — requeued 2x)`. 이미 `ORPHAN_EXCLUSION`으로 분모에서 제외되고 있어
  현재 완료율에는 영향 없음(7/11 시점 기준). 재시작 빈도 자체는 별도 인프라 이슈.

## 4. 적용한 바운디드·리버서블 수정 (사이클 2/3)

가설 1·2에 대응해 스코어러의 인프라 실패 제외를 서킷브레이커까지 확장했다.

- `src/core/team-scorer.ts`
  - `ORPHAN_EXCLUSION` → `INFRA_EXCLUSION`으로 확장:
    `error NOT LIKE 'orphaned:%' AND error NOT LIKE 'Circuit breaker open%'`.
  - 근거 주석(agent-manager.ts:135 미실행 즉시실패, 실측 건수, 롤백 방법) 갱신.
  - 정상 품질 실패(unknown/timeout/lease_expired)와 완료 후 품질반려는 그대로 계상.
- `src/core/team-scorer.test.ts`
  - 서킷브레이커 실패 행을 추가해 분모 제외를 검증하는 회귀 케이스 추가
    (alpha n=4·completion=75 유지 → 제외 미동작 시 n=5·60으로 깨짐).

롤백: 3개 terminal CASE에서 `INFRA_EXCLUSION` 조건을 제거하거나 커밋을
`git revert` 하면 정확히 이전 동작으로 복귀.

## 5. 측정된 효과 (실측, live DB)

동일 SQL을 live `db/nco.db`에 적용한 team 02 48h 창 결과:

| 기준 | terminal(분모) | completed | completion |
|---|---:|---:|---:|
| BEFORE (orphan-only 제외) | 11 | 7 | 63.6% |
| AFTER (infra 제외, 서킷브레이커 포함) | 7 | 7 | **100%** |

해석: 팀이 실제로 실행한 작업 7건은 전부 완료됐으며, 품질반려 0건. 완료율 정체의
원인은 팀 산출물이 아니라 오프라인 에이전트로의 중복 팬아웃이었음이 실증됐다.

## 6. 검증 로그 (T1)

```text
$ npx vitest run src/core/team-scorer.test.ts
 Test Files  1 passed (1)
      Tests  1 passed (1)
 exit code 0

$ npx tsc --noEmit
 (출력 없음) exit code 0
```

live DB 조회(§5)는 `sqlite3 db/nco.db` 읽기 전용 실행 결과.

## 7. Gap / 미검증 항목

- **[미검증]** 수정된 스코어러로 산출되는 최종 `score` 절대값 — volume 정규화가
  전체 팀 maxN에 의존하므로 다음 스코어러 실행 시점에만 확정. 본 노트는 completion
  100%(7/7)까지만 실측 주장하고 score 절대값은 주장하지 않는다.
- **[미검증]** 차기 48h HR 재측정 지표(관찰 기간 미도래).
- **[미검증]** claude-code 재온라인 후 동일 work report 팬아웃 재발 여부.
- 근본 라우팅 이슈(오프라인 에이전트로의 중복 사본 배정)는 이번 스코어링 공정성
  수정 범위 밖. 활성 task 중복은 `db/migrations/085_active_work_report_task_idempotency.sql`
  + `src/server/task-intake.ts`가 이미 부분 방어(실패 후 constraint 해제 시 재생성은
  잔존). 별도 사이클에서 다룰 것.

## 8. 판정

- 등급: **T1** — 실제 `tasks` 행·`verifier_result_json`·`metadata_json`, 변경 파일
  내용, vitest/tsc 본문, live DB before/after 조회를 직접 확인.
- 완료율 정체 근본원인 = 오프라인 에이전트 서킷브레이커 팬아웃(인프라), 팀 품질 아님.
</content>
</invoke>

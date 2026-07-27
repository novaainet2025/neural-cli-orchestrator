# 중복에러방지팀 감사 — team_gov-evolution-learning (Continuous Learning)

- 감사일: 2026-07-27
- 표본: 48시간, 팀 태스크 7건 / 함대 전체 실패 행 326건
- DB 스냅샷: `db/nco.db` → `/tmp/nco-audit.db` 복사본 (읽기 전용 조회)
- 산출물: `gov-evolution-learning-task-audit.csv`, `gov-evolution-learning-audit.json`,
  `../gov-evolution-learning-stage-gate.patch`

---

## 0. 요약

| 항목 | 결과 |
|---|---|
| 허위 보고(완료 주장 ↔ DB/파일 기록 누락) | **0건** |
| 산출물 주장 파일 부재 | 0건 (2건 주장 → 2건 실재 확인) |
| work_report 행 누락 | 0건 (submitted 3/3) |
| **보고서 수치 ↔ DB 실패 기록 모순** | **2건** (신규 발견) |
| 중복 실패 버스트 | 22건 / 소속 실패 행 131건 |
| 그중 스코어러가 이미 제외 중인 행 | **131건 / 131건 (100%)** |
| Circuit Breaker 임계치 조정 필요성 | **없음** (근거는 §3) |

HR 지시문의 `score=75.7, completion=80%`는 stale 스냅샷이다. HEAD의
`computeTeamScores()`를 같은 DB에 직접 실행하면 **score=93.7, grade=A, completion=100%, n=5**다.

---

## 1. 허위 보고 교차 검증 — 0건

완료를 주장한 5건 전부에 대해 (a) 주장한 산출물 파일의 실재, (b) 연결된 `work_reports`
행의 존재·상태를 대조했다. 전부 일치했다.

| task_id | 상태 | 주장 | DB/파일 대조 |
|---|---|---|---|
| `task_53abN7hMCQcH5SrT` | completed | 보고 본문 인라인 | `wr_bBF2I0obDvf5VY7V` submitted, body 699자 ✔ |
| `task_RQlrDP4SNwpAZOEP` | completed | "변경 파일 없음" | 산출물 주장 없음 (team-runner 진단) ✔ |
| `task_-0trMvKZRQtsf1k3` | completed | 산출물 주장 없음 | ✔ |
| `task_f1CCNcEiOGMMpq-Z` | completed | `REPORTS/2026-07-27-Continuous-Learning-오전.md` 51행 | 파일 실재, **51행** 일치 ✔ |
| `task_TF-0pwR0YBvnvs0b` | completed | `REPORTS/2026-07-27-Continuous-Learning-오후.md` 41행 | 파일 실재, **41행** 일치 ✔ |

`false_reports` 테이블은 전체 0행이다 — 이 팀에 한정된 문제가 아니라 해당 기록 경로가
아직 아무 데이터도 축적하지 않았다는 뜻이며, 이번 감사의 대조는 원천 테이블
(`tasks`·`work_reports`·파일시스템)으로 직접 수행했다.

---

## 2. 신규 발견 — 보고서가 실패를 구조적으로 은폐한다 (STALE_DATA_CONTEXT / FAILURE_UNDERCOUNT)

허위 보고의 방향이 반대다. **"완료 주장했는데 DB 기록이 없는" 것이 아니라, DB에 실패
기록이 있는데 보고서가 그것을 보지 못한다.**

### 2.1 증거

`wr_wcXz4AG_W0eFppWp` 하나가 3개 태스크로 확산됐고, 세 태스크의 prompt SHA-1이 전부
동일하다:

```
244ba0ac69772b888caa302755304e34660090ab  task_3eejRUftHpUXmdOH  (parent, 05:29:17, opencode, failed)
244ba0ac69772b888caa302755304e34660090ab  task_IjCXiEO-3LT65aIS  (06:04:57, claude-code, failed)
244ba0ac69772b888caa302755304e34660090ab  task_TF-0pwR0YBvnvs0b  (06:53:25, codex,      completed)
```

두 자식의 `parent_task_id`는 모두 `task_3eejRUftHpUXmdOH`다. 즉 스케줄러의 재발행이
아니라 **provider failover 복제**이며, 복제본은 부모의 프롬프트를 바이트 단위로 승계한다.
그 안의 `[실데이터]` 블록은 05:29:17 시점에 동결된 값이다:

```
[tasks] 최근 7일: 전체=4, 완료=4, 실패성=0, 진행=0, 완료율=100.0%
```

07:11:49에 제출된 오후 보고서는 이 값을 그대로 서술했다. 그러나 그 시점 DB에는 이 팀의
종결 실패가 2건(`task_3eejRUftHpUXmdOH` 06:04:57, `task_IjCXiEO-3LT65aIS` 06:53:25)
이미 존재했다. 시점 재구성 카운터는 `전체=6, 완료=4, 실패성=2`다.

### 2.2 왜 에이전트 탓이 아닌가

프롬프트 요구사항 5번은 "`[실데이터]`에 있는 값만 사실로 사용하고 없는 수치를 지어내지
않는다"이다. 에이전트는 이 지시를 정확히 지켰다. 지시를 성실히 따를수록 실패가 은폐되는
구조이므로, 교정 지점은 에이전트가 아니라 프롬프트 스냅샷의 수명이다.

### 2.3 게이트 실행 결과 (실 DB)

| task_id | 주입 스냅샷 | 생성 시점 실제 | 판정 |
|---|---|---|---|
| `task_53abN7hMCQcH5SrT` | (없음) | 0/0/0/0 | 통과 — 표본 0건이면 `[tasks]` 줄 미주입이 정상 |
| `task_RQlrDP4SNwpAZOEP` | 1/1/0/0 | 1/1/0/0 | 통과 |
| `task_-0trMvKZRQtsf1k3` | 2/2/0/0 | 2/2/0/0 | 통과 |
| `task_f1CCNcEiOGMMpq-Z` | 3/3/0/0 | 3/3/0/0 | 통과 |
| `task_3eejRUftHpUXmdOH` | 4/4/0/0 | 4/4/0/0 | 통과 (원본은 신선했다) |
| `task_IjCXiEO-3LT65aIS` | 4/4/0/0 | 5/4/1/0 | **STALE + UNDERCOUNT + CLONED** |
| `task_TF-0pwR0YBvnvs0b` | 4/4/0/0 | 6/4/2/0 | **STALE + UNDERCOUNT + CLONED** |

7건 중 2건 차단, 건강한 5건 전부 통과 = **오탐 0건**.

---

## 3. 중복 실패 버스트 — 발견했으나 CB 임계치 조정은 불필요

`detectDuplicateFailureBursts()`를 48시간 함대 실패 326행에 돌려 **22개 버스트, 131개
실패 행**을 찾았다. 정의: 같은 에이전트 + 같은 정규화 에러 + 같은 1초에 종결 + 서로 다른
팀 2개 이상.

대표 사례:

| 시각 | 에이전트 | 시그니처 | 태스크 | 영향 팀 |
|---|---|---|---|---|
| 2026-07-27 01:52:41 | claude-code | `queue_wait_timeout` | 33 | **31** |
| 2026-07-27 01:15:43 | claude-code | `queue_wait_timeout` | 23 | 23 |
| 2026-07-26 06:04:25 | claude-code | `orphaned: server restart` | 9 | 9 |
| 2026-07-27 06:53:25 | claude-code | `provider_unavailable` | 4 | 4 |

마지막 행이 이 팀에 계상된 실패다. 단일 회로 개방 이벤트가 4개 팀에 각각 1건씩 품질
실패를 뿌렸고, 큐 대기 시간은 48.2~48.8분으로 균일했다.

### 3.1 왜 CB 임계치를 건드리지 않는가

131개 버스트 행 전부가 `src/core/team-scorer.ts:178` `INFRA_EXCLUSION`의 4개 패턴
(`orphaned:%`, `Circuit breaker open%`, `provider_unavailable:%`, `queue_wait_timeout:%`)
중 하나에 이미 걸린다. **미커버 = 0건.** 즉 스코어러는 이 버스트들을 이미 팀 품질에서
빼고 있으며, 이 팀의 실측 completion이 100%인 이유도 그것이다.

Circuit Breaker 자체도 오작동하지 않았다. `escalation-policy.decideEscalation()`은 결정
시점에 `circuitOpenAgents`를 이미 걸러낸다(`src/core/escalation-policy.ts:88`). 문제는
임계치가 아니라 **선정 시점과 실행 시점 사이의 TOCTOU**다: 06:37:25에 codex→claude-code로
에스컬레이션할 때 claude-code는 가용이었고, 큐에서 48분 대기하는 사이 회로가 열려
06:53:25 `agent-manager.executeTask`의 `sandbox.canExecute()`에서 재라우팅 없이 종결
실패했다(`src/agent/agent-manager.ts:142-154`).

임계치를 낮추면 가용한 프로바이더까지 배제되어 처리량이 떨어지고, 높이면 이 실패가 더
늘어난다. 어느 쪽도 이 패턴을 고치지 못한다. 따라서 **임계치 무변경**을 권고하고, 대신
버스트를 *식별*하는 함수만 제공한다.

---

## 4. 제안 패치 (초안, 미배선)

`src/security/learning-stage-gate.ts` + `src/security/learning-stage-gate.test.ts`
(patch: `../gov-evolution-learning-stage-gate.patch`, 441줄)

순수 함수 모듈이며 **어떤 실행 경로에도 import되지 않았다**. DB·네트워크 접근 없음,
`Date.now()`/`Math.random()` 미사용(결정론적). 예외를 던지지 않고 위반 목록만 반환한다
(fail-flag). 보고 파이프라인을 차단하면 missed가 늘어 completion이 오히려 나빠지므로
차단이 아닌 표시를 기본값으로 뒀다.

| export | 역할 |
|---|---|
| `parseInjectedTaskMetrics(prompt)` | `[tasks] 최근 7일: …` 줄 파싱 |
| `evaluateLearningStageGate(input)` | 주입 스냅샷 ↔ 실제 카운터 대조 + 복제 프롬프트 탐지 |
| `normalizeErrorSignature(error)` | 괄호 상세·숫자 제거로 동일 계열 에러 묶기 |
| `detectDuplicateFailureBursts(rows, opts)` | 인프라 단일 이벤트의 다팀 팬아웃 식별 |

위반 코드: `STALE_DATA_CONTEXT`, `FAILURE_UNDERCOUNT`, `CLONED_PROMPT_SNAPSHOT`,
`MISSING_TASK_METRICS`.

### 배선 시 권고 지점 (이번에 수행하지 않음 — HR 결정 사항)

1. `work-report-scheduler`의 failover 복제 경로에서 `buildTeamDataContext()`를 재호출해
   프롬프트를 재빌드 — `CLONED_PROMPT_SNAPSHOT`의 근본 해결.
2. 재빌드가 곤란하면 `evaluateLearningStageGate()`의 violations를 보고서 하단 각주로
   주입해, 보고서가 자기 데이터의 지연을 스스로 밝히게 한다.
3. `detectDuplicateFailureBursts()`를 스코어러 제외 사유 로깅에 붙여, 현재 문자열 패턴
   기반 `INFRA_EXCLUSION`이 놓치는 신종 시그니처를 조기에 드러낸다.

되돌리기: 두 파일 삭제, 또는 `git apply --reverse 08-IMPROVEMENTS/gov-evolution-learning-stage-gate.patch`.

---

## 5. 미검증 항목

- 게이트를 실제 파이프라인에 배선했을 때의 런타임 영향 — 배선하지 않았으므로 미측정.
- `false_reports` 테이블이 0행인 이유(기록 경로 미동작 여부) — 이번 범위 밖.
- 22개 버스트 중 이 팀 무관 21건의 개별 근본 원인 — 스코어러 커버리지만 확인했고
  각 인프라 이벤트 자체는 조사하지 않았다.
- 시점 재구성 카운터는 `completed_at`으로 종결 시각을 판정한다. `completed_at`이 NULL인
  종결 행이 있다면 active로 계상되어 실패를 과소평가할 수 있다(이 팀 표본에는 없음).

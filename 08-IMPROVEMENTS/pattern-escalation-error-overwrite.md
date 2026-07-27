# escalation 재배정의 최종 error 덮어쓰기 패턴

작성: 2026-07-28 KST  
대상: `team_content-planning` cycle 2/3에서 fleet 공통 패턴으로 일반화  
변경 경계: 분석 노트 1건 + Mem0 1건만 추가. 런타임 코드·팀 lifecycle은 변경하지 않음.

## 결론

`tasks.error`는 태스크 전체의 원인을 보존하는 필드가 아니라 **마지막 실행 시도의 오류
문자열**이다. 반면 재배정 이전 실패는 `metadata_json.escalationHistory[].reason`에 남는다.
스코어 제외 규칙이 최종 `error` 접두사만 보면, 최초 시도가
`Circuit breaker open`·`provider_unavailable`·`queue_wait_timeout` 같은 인프라
가용성 실패였어도 다음 시도의 ENOENT·인증 실패·빈 응답 문자열이 이를 덮어써 매칭이
깨진다.

cycle 1의 `task_content_generation`은 이 패턴의 한 사례다.

```text
escalationHistory[0].reason
  provider_unavailable: opencode (open/generic)
tasks.error
  cursor-agent: CLI failed exit=unknown — Command failed with ENOENT: cursor-agent ...
```

`response`·`result_json`·`evidence_json`은 모두 0바이트이고 `progress=0.0`이다. 따라서
이 행은 팀 산출물 실패가 아니라 실행 주체가 시작되지 못한 가용성 사건이다. 같은 시각
다른 cursor-agent 태스크가 성공했으므로 좁은 PATH 가설은 반증됐고, 일반화할 대상은
특정 바이너리가 아니라 **시도별 원인을 단일 mutable 문자열로 축약하는 데이터 모델**이다.

중요한 경계: 아래 목록은 “과거 인프라 사유와 최종 error 분류가 달라진 재검증 후보”다.
이전 시도에 인프라 실패가 있었다는 이유만으로 최종 시도의 실제 품질 실패까지 자동 제외하면
안 된다. 제외는 spawn 미기동, heartbeat 없음, 산출물 없음, 인증 오류 봉투처럼 별도
증거 가드가 있을 때만 가능하다.

## 48시간 탐지 결과

측정 DB: `db/nco.db`  
측정 시각: `2026-07-27 18:54:51 UTC`  
창: `2026-07-25 18:54:51 UTC` 이후 `created_at`  
스코어 terminal 상태: `completed`, `failed`, `timed_out`, `lease_expired`

| 항목 | 실측 |
|---|---:|
| 48h terminal 태스크 | 1,104 |
| escalationHistory가 있는 terminal 태스크 | 312 |
| 과거 인프라 사유가 최종 INFRA_EXCLUSION 문자열에서 사라진 실패 | 15 |
| team_id가 있는 영향 후보 팀 | 9 |
| team_id가 없는 후보 | 2 |

과거 사유별 후보는 `provider_unavailable` 7건, `queue_wait_timeout` 6건,
`circuit-breaker` 2건이다. 같은 창의 최종 행 자체에는 circuit-breaker 78건,
provider_unavailable 33건, 산출물 없는 spawn ENOENT 1건,
lease-never-ran 0건이 있었다. 이 수치는 서로 다른 탐지 축이다.

### 영향 후보 팀

| 팀 | 후보 태스크 | 관찰된 전이 | task ID |
|---|---:|---|---|
| `team_self-learning` / 자가학습팀 | 4 | provider_unavailable→provider-auth; circuit-breaker→empty-completion | `task_IkKQEYErfegOFc6R`, `task_u_VTwDmVodFpsNDX`, `task_HWShOuugEQE4gDzh`, `task_Gj6LtVtOQl33TZ_y` |
| `team_gov-command-collaboration` | 2 | provider_unavailable→provider-auth; queue_wait_timeout→silent-failure | `task_4aq6FQ3yZuXoiTdK`, `task_vul5sMk4wNuu-aQB` |
| `team_autonomy-controller` | 1 | circuit-breaker→empty-completion | `task_nv8TvY_zYKx3ncpQ` |
| `team_computer-use-queue` | 1 | queue_wait_timeout→connection-closed | `task_aGTLT4BLxSnCXQvn` |
| `team_content-planning` / 콘텐츠 기획팀 | 1 | provider_unavailable→spawn-ENOENT | `task_content_generation` |
| `team_gov-assurance-audit` | 1 | queue_wait_timeout→other-final-error | `task_7U-jEljr8bgs-1jI` |
| `team_gov-evolution-learning` | 1 | queue_wait_timeout→silent-failure | `task_3eejRUftHpUXmdOH` |
| `team_research-strategy` / 리서치 기획·전략팀 | 1 | queue_wait_timeout→interrupted | `task__zXpjggKrqmyv0Of` |
| `team_support-lead` | 1 | queue_wait_timeout→empty-completion | `task_qR-3O0LBS0j7VIBQ` |

표의 13개 team-scoped 행 외에 team 미귀속 2개가 있다. `provider-auth`,
`empty-completion` 같은 표기는 최종 문자열을 축약한 분류이며 실제 오류 원문을 대체하지
않는다. 현재 scorer의 spawn/auth/중복 work-report 같은 후속 가드가 일부 행을 별도로
제외할 수 있으므로, 이 표를 점수 하락량이나 일괄 제외 목록으로 해석하지 않는다.

## 탐지 SQL

다음 쿼리는 scorer가 사용하는 terminal 상태와 48시간 `created_at` 창을 그대로 사용한다.
`json_each`로 모든 escalation hop을 펴고, 과거 인프라 사유가 있는데 최종 error가 기존
`INFRA_EXCLUSION` 접두사 어느 것에도 맞지 않는 행만 찾는다. 한 태스크에 여러 hop이 있어도
`DISTINCT`로 한 번만 센다.

```sql
WITH escalated AS (
  SELECT
    t.*,
    json_extract(j.value, '$.reason') AS escalation_reason,
    CASE
      WHEN json_extract(j.value, '$.reason') LIKE 'Circuit breaker open%'
        THEN 'circuit-breaker'
      WHEN json_extract(j.value, '$.reason') LIKE 'provider_unavailable:%'
        THEN 'provider_unavailable'
      WHEN json_extract(j.value, '$.reason') LIKE 'queue_wait_timeout:%'
        THEN 'queue_wait_timeout'
    END AS source_class
  FROM tasks AS t
  JOIN json_each(t.metadata_json, '$.escalationHistory') AS j
  WHERE json_valid(t.metadata_json)
    AND t.status IN ('failed', 'timed_out', 'lease_expired')
    AND t.created_at >= datetime('now', '-48 hours')
),
mismatch AS (
  SELECT DISTINCT
    id,
    team_id,
    status,
    assigned_to,
    created_at,
    escalation_reason,
    source_class,
    error AS final_error,
    response,
    result_json
  FROM escalated
  WHERE source_class IS NOT NULL
    AND NOT (
      COALESCE(error, '') LIKE 'orphaned:%'
      OR COALESCE(error, '') LIKE 'Circuit breaker open%'
      OR COALESCE(error, '') LIKE 'provider_unavailable:%'
      OR COALESCE(error, '') LIKE 'queue_wait_timeout:%'
    )
)
SELECT
  team_id,
  COUNT(*) AS task_count,
  GROUP_CONCAT(id) AS task_ids
FROM mismatch
GROUP BY team_id
ORDER BY task_count DESC, team_id;
```

구조화된 가용성 증거는 최종 문자열과 별도로 감시한다.

```sql
SELECT
  SUM(
    status = 'lease_expired'
    AND acked_at IS NOT NULL
    AND COALESCE(last_heartbeat_at, '') = ''
  ) AS lease_never_ran,
  SUM(
    status <> 'completed'
    AND COALESCE(error, '') LIKE '%Command failed with ENOENT:%'
    AND COALESCE(response, '') = ''
    AND COALESCE(result_json, '') = ''
  ) AS spawn_enoent_never_started
FROM tasks
WHERE status IN ('completed', 'failed', 'timed_out', 'lease_expired')
  AND created_at >= datetime('now', '-48 hours');
```

운영 탐지에서는 두 쿼리를 합쳐 다음을 구분해야 한다.

1. `history mismatch`: 과거 원인과 최종 문자열이 달라진 재검증 후보
2. `structured infra`: heartbeat·산출물·인증 봉투 등으로 실행 미성립이 입증된 제외 후보
3. `real final failure`: 다음 시도가 실제 작업을 시작해 산출물을 냈거나 품질 실패가 입증된 행

## 외부 주입 고정 ID 추적

### DB provenance 부재

현재 두 행은 다음 provenance 필드가 모두 비어 있다.

| task ID | created_at UTC | prompt | 최초 assigned_to | `metadata.created_by` | `metadata.source` | `spawned_by_cli` | 현재 행 구간 task 이벤트 |
|---|---|---|---|---|---|---|---:|
| `task_trend_collector` | `2026-07-27 15:00:04` | `트렌드 키워드 수집 및 분석 중` | `mlx` | NULL | NULL | NULL | 0 |
| `task_content_generation` | `2026-07-27 17:10:06` | `누락된 SEO 키워드 분석 및 최적화 중` | `mlx` | NULL | NULL | NULL | 0 |

`task_content_generation`의 현재 metadata에는 NCO가 orphan 채택 후 추가한
`attemptedAgents`, `reassignedFrom`, `escalationHistory`만 있다.
`task_trend_collector`의 metadata는 NULL이다. 두 행 모두 현재 `created_at`부터
`completed_at`까지 `agent_actions`의 `task:created`, `task:completed`, `task:failed`,
`task:failover` 이벤트가 0건이다.

NCO 저장소의 `src`, `scripts`, `config`, `db/migrations`에서 두 고정 ID를 검색했을 때
실행 생성 코드는 발견되지 않았고, 현재 발견된 NCO 참조는 회귀 테스트와 진단 주석이다.

### 주입 주체

주입 주체는 `/Users/nova-ai/project/nova-sns/automation`의 자동화 스크립트로
파일 내용과 로그를 교차확인했다.

- `trend-collector.py:400-431`
  - `/Users/nova-ai/project/nco/db/nco.db`를 sqlite3로 직접 연다.
  - `status='running'`이면 `INSERT OR REPLACE INTO tasks`를 실행한다.
  - 고정 ID `task_trend_collector`, team `team_content-planning`, provider `mlx`,
    위 prompt를 쓴다.
  - 외부 `logs/cron.log`의 `2026-07-28 00:00:04 KST 트렌드 수집 시작`과
    DB `created_at=2026-07-27 15:00:04 UTC`가 정확히 일치한다.
- `content-gen.py:770-824`
  - 같은 DB 직접쓰기 함수를 사용한다.
  - `--fill-seo` 분기에서 고정 ID `task_content_generation`, 같은 team/provider/prompt를 쓴다.
  - 외부 `logs/scheduler.log`의 `2026-07-28 02:10:06 KST 1단계 --batch 완료`
    직후 소스 순서상 `--fill-seo`를 실행하며, DB
    `created_at=2026-07-27 17:10:06 UTC`와 초 단위로 일치한다.

따라서 두 현재 행은 NCO task API나 task event 경로가 아니라 nova-sns 스케줄러가 raw
SQLite로 주입한 행으로 판정한다. `crontab -l`은 현재 sandbox에서
`operation not permitted: crontab`으로 확인하지 못했지만, 실행 파일의 직접 DB write,
정확한 ID·team·provider·prompt 일치, 외부 로그와 DB UTC↔KST 시각 일치가 독립 근거다.

고정 ID에 `INSERT OR REPLACE`를 쓰므로 이전 행과 provenance가 교체된다. 그 결과
`created_by/source` 부재뿐 아니라 과거 동일 ID의 agent event가 현재 행의 event처럼
보일 수 있다. event를 사용할 때는 반드시 현재 행의 `[created_at, completed_at]` 창으로
제한해야 한다.

## 재발 방지 체크리스트

- [ ] `tasks.error`를 원인 원장으로 사용하지 않는다. `root_cause_code`,
  `last_attempt_error`, append-only `attempts[]`/failure event를 분리한다.
- [ ] escalation 전에 원인 코드와 `fromAgent`, `toAgent`, attempt 번호를 불변 이벤트로 남긴다.
- [ ] scorer는 mutable 문자열 하나가 아니라 정규화된 원인 코드와 실행 증거를 함께 본다.
- [ ] 기존 인프라 prefix가 history에는 있으나 final error에서 사라진 행을 위 SQL로 매일 감시한다.
- [ ] history가 인프라였다는 이유만으로 자동 제외하지 않는다. response/result/evidence 0,
  heartbeat 없음, 인증 오류 봉투 등 미실행 증거를 요구한다.
- [ ] circuit-breaker→empty, provider_unavailable→spawn ENOENT,
  provider_unavailable→auth, queue_wait_timeout→silent-failure,
  lease-never-ran의 회귀 fixture를 각각 유지한다.
- [ ] 외부 주입자는 raw `tasks` INSERT를 쓰지 않고 NCO API/event 경로를 사용한다.
- [ ] 모든 생성 행에 `created_by`, `source`, `source_run_id`, idempotency key를 기록한다.
- [ ] 실행마다 새 task ID를 만들고 고정 ID는 별도 idempotency key로만 사용한다.
- [ ] fixed-ID 행의 agent action 대조는 현재 행의 timestamp 창으로 제한한다.
- [ ] 팀 score 수정 전 실제로 해당 행이 현행 scorer에 포함되는지 별도 재계산한다.
- [ ] 팀 lifecycle/status/retirement는 HR 승인 없이 변경하지 않는다.

## 빌드·타입체크

- `npm run typecheck` → exit 1. TypeScript 진단 전 tsx IPC 생성이
  `Error: listen EPERM .../tsx-501/3598.pipe`로 차단됐다.
- `npm run build` → exit 1. 같은 tsx IPC 오류
  (`Error: listen EPERM .../tsx-501/15067.pipe`)로 컴파일 전 실패했다.
- 동일 package script 본체를 IPC가 없는 Node import hook으로 실행:
  - `env PATH="$PWD/node_modules/.bin:$PATH" node --import tsx scripts/run-with-work-event.ts --event-type regression:typecheck -- tsc --noEmit`
    → exit 0; `work_events.id=evt_LveMIPeIYD1dflxs`,
    `regression:typecheck:passed`, `exitCode=0`.
  - `node --import tsx scripts/run-with-work-event.ts --event-type regression:build -- ./node_modules/.bin/tsc`
    → exit 0; `work_events.id=evt_DedQK-IfjOtfSzTF`,
    `regression:build:passed`, `exitCode=0`.
- delivery gate `run-delivery-gate.sh --quick` → exit 2,
  `PASS=0 FAIL=2 SKIP=0`: dirty worktree inspection과 정확한 npm typecheck wrapper가 실패했다.
- 문서·메모리만 변경했으므로 런타임 테스트는 추가로 실행하지 않았다.

따라서 TypeScript typecheck와 build 본체는 통과했지만, 정확한 npm wrapper와 delivery
gate 전체 통과는 확인되지 않았다.

## 범위·되돌리기

- 코드 수정: 0건
- DB task/team/lifecycle 변경: 0건
- 추가 파일: `08-IMPROVEMENTS/pattern-escalation-error-overwrite.md`
- 추가 메모리: `mem0-85663067090ab507179ec4414fc419f0` (`agent_id=codex`,
  `embedded=0`). NCO HTTP가 연결 거부 상태여서 API 대신 동일 `mem0_entries` 스키마에
  중복 방지 단일 트랜잭션으로 1행을 기록했다.
- 되돌리기: 이 노트와 해당 단일 Mem0 entry만 개별 제거한다. 팀을 삭제·비활성화하지 않는다.

## 검증 영수증

- [Evidence Tier 1] `db/nco.db`의 tasks/agent_actions 행, NCO 및 nova-sns 소스 파일,
  nova-sns 로그 파일 내용을 직접 확인했다.
- [Evidence Tier 1] Mem0 insert 결과 `inserted_rows=1`과 ID
  `mem0-85663067090ab507179ec4414fc419f0`의 DB 행 내용을 재조회했다.
- [미검증] crontab 실설치 내용(`operation not permitted: crontab`), NCO HTTP Mem0 경로
  (`curl: (7) Failed to connect to localhost port 6200`), semantic embedding, 런타임 코드 개선,
  후속 48시간 점수 변화, 정확한 npm wrapper 및 delivery gate 통과.
- Mem0 ID: `mem0-85663067090ab507179ec4414fc419f0`

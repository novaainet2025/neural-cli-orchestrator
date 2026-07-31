# Discussion 고아 및 슬롯 acquire 고착 회수 설계

작성일: 2026-07-30
범위: 설계만. 이 문서는 구현 코드, DB 데이터, circuit breaker 임계치를 변경하지 않는다.

## 0. 확인된 현재 상태

### DB 스냅샷

`db/nco.db`를 read-only로 조회한 2026-07-30 13:35:57 UTC 시점의 지상 진실은 다음과 같다.

- `discussions.status='active' AND ended_at IS NULL`: 36건
  - `discussion`: 34건
  - `consensus`: 1건
  - `parallel`: 1건
- `tasks.status='assigned' AND lease_expires_at IS NULL`: 8건
- `discussions.status='timed_out'`의 최신 `created_at`: `2026-06-14 11:43:53`
- `discussions.status='timed_out'`의 최신 `ended_at`: `2026-06-15 12:13:59`

조사 중 같은 쿼리의 수가 discussion 35→36, task 4→7→8로 변했다. 따라서 위 숫자는 시점 스냅샷이며, 누적 문제의 존재를 증명하지만 고정된 현재값으로 취급하면 안 된다.

### 소스에서 확인된 사실

- `startDiscussion()`은 실행 시작 전에 discussion 행을 `active`로 저장한다. 이후 메서드 전체를 감싸는 terminal 보장 `try/catch/finally`는 없다 (`src/core/discussion-engine.ts:400-440`).
- 단계별 `AbortSignal.timeout()` 상한은 환경변수로 조정되지만 900,000ms(15분) ceiling으로 clamp된다 (`src/core/discussion-engine.ts:125-143`).
- R1 정족수 미달만 명시적으로 `failed`와 `ended_at`을 기록한다 (`src/core/discussion-engine.ts:539-564`). 정상 round-based 종료와 hive 종료는 각각 `completed`를 기록한다 (`src/core/discussion-engine.ts:712-739`, `src/core/discussion-engine.ts:870-898`).
- provider 단계는 timeout을 사용하지만, `updated_at`은 provider 메시지 저장 시점이 아니라 `saveRound()`이 끝날 때만 갱신된다 (`src/core/discussion-engine.ts:1005-1024`, `src/core/discussion-engine.ts:1143-1170`, `src/core/discussion-engine.ts:1458-1494`).
- 장기 세션 용도의 `startRealtimeDiscussion()`은 `active`를 저장하고 listener를 설치한 뒤 session ID를 반환한다. 정상 종료 메서드는 현재 소스에 없다 (`src/core/discussion-engine.ts:903-950`, `src/core/discussion-engine.ts:1188-1242`).
- discussion 회수 경로가 “전혀 없다”는 진술은 현재 HEAD에는 맞지 않는다. `failStaleDiscussions()`가 24시간 기본 cutoff로 stale active discussion을 `failed`로 바꾸며 (`src/core/workflow-gate.ts:548-588`), `createGateway()`가 부팅 중 이를 1회 호출한다 (`src/server/gateway.ts:1236-1263`; 호출 진입은 `src/index.ts:366-369`). 다만 주기 실행은 없다.
- task는 부팅 시 `queued/assigned/in_progress/running/streaming`을 조회해 재큐잉 또는 dead-letter 처리한다 (`src/index.ts:79-188`). 실제 재enqueue는 queue 초기화 뒤 수행된다 (`src/index.ts:286-352`).
- API task 행은 enqueue 전에 `assigned`로 저장된다 (`src/server/gateway.ts:2139-2183`). lease는 `startRuntime()`이 호출한 `markTaskExecutionStarted()` 안에서 처음 발급된다 (`src/core/task-queue.ts:133-143`, `src/core/task-queue.ts:2050-2076`; 실제 lease 갱신은 `src/core/lease-sweeper.ts:42-61`).
- 두 agent slot 대기는 실제로 timeout이 없다: BullMQ worker의 `runJob()` (`src/core/task-queue.ts:1321-1335`)과 Redis-offline 경로의 `enqueueSemaphore()` (`src/core/task-queue.ts:1829-1844`). 현재 `Semaphore.acquire()`도 취소 가능한 waiter를 지원하지 않는다 (`src/core/task-queue.ts:1080-1118`).
- lease sweeper는 `lease_expires_at IS NOT NULL`인 `assigned`만 회수하므로 pre-runtime waiter는 대상이 아니다 (`src/core/lease-sweeper.ts:109-127`).

---

## 문제 A — discussion 고아 누적

### 1. 회수/해제 트리거

권고안은 **즉시 terminal 보장 + 부팅 1회 + 주기 sweeper**의 3중 방어다.

1. **즉시 terminal 보장**
   - 실제 `startDiscussion()`과 `executeHive()`에서 `active` INSERT 이후 실행 구간을 terminal 보장 경계로 감싼다.
   - 처리되지 않은 예외가 경계를 빠져나가면, 아직 `active`인 행만 compare-and-set으로 종결한다.
   - stage timeout 계열이면 `timed_out`, 그 밖의 예외면 `failed`로 분류한다.
   - 이는 오류 직후 회수하는 주 경로이며 sweeper 지연을 기다리지 않는다.

2. **부팅 1회**
   - 현재 `createGateway()`의 `failStaleDiscussions()` 호출을 유지하되 V2 회수 정책을 적용한다. 별도로 `src/index.ts`에서 중복 호출하지 않는다.
   - 이 호출은 `createGateway()`가 `boot()`에서 gateway listen 전에 실행되므로 부팅 회수 계약을 이미 충족한다 (`src/index.ts:366-385`).

3. **주기 sweeper**
   - 동일한 회수 함수를 기본 60초 간격으로 실행한다.
   - 이전 tick이 끝나지 않았으면 다음 tick을 건너뛰고, Fastify `onClose`에서 timer를 해제한다. 현재 gateway가 다른 timer에 쓰는 lifecycle 패턴을 따른다 (`src/server/gateway.ts:1238-1248`).
   - 각 bounded provider 실행 직전/직후와 성공/실패 메시지 저장 직후 `discussions.updated_at`을 touch한다. 기존 `saveRound()` touch는 그대로 둔다.
   - heartbeat가 추가된 뒤 stale 기본값은 30분으로 둔다. 현재 한 provider call의 hard ceiling 15분보다 2배 길어 정상 단일 단계가 cutoff를 넘지 않게 한다.

초기 릴리스의 sweeper는 DB/워크플로 상태만 종결하며 provider 프로세스에 `abort()`나 OS signal을 보내지 않는다. 강제 프로세스 종료는 별도 설계·승인 없이는 포함하지 않는다.

### 2. 상태 전이 및 오탐 방지

#### 상태 전이

- 처리되지 않은 timeout/abort 계열 예외:
  - `active → timed_out`
  - `report='discussion_stage_timeout:<stage>'`
  - `ended_at`, `updated_at` 설정
- 처리되지 않은 비-timeout 예외:
  - `active → failed`
  - 원인 코드가 포함된 bounded report 저장
  - `ended_at`, `updated_at` 설정
- sweeper inactivity cutoff 초과:
  - `active → timed_out`
  - `report='discussion_stale_timeout'`
  - `ended_at`, `updated_at` 설정
- 연계 `workflow_stages`는 `timed_out` 상태를 허용하지 않는다 (`src/core/workflow-gate.ts:17-31`). 따라서 discussion의 `timed_out`은 기존 계약대로 stage `failed` + `error='discussion_stale_timeout'`으로 투영하고 `refreshWorkflowRun()`을 호출한다. 소비 측 progress는 이미 `timed_out`을 실패로 인식한다 (`src/core/discussion-progress.ts:37-49`, `src/core/discussion-progress.ts:66-70`).

#### 오탐 방지

- sweeper 대상은 bounded mode whitelist인 `task`, `parallel`, `discussion`, `consensus`, `hive`, `commander`만 허용한다. `realtime`과 `broadcast`는 제외한다.
- SQL은 사전 SELECT 결과만 믿지 않고 다음 조건을 UPDATE 자체에 다시 넣는다.
  - `status='active'`
  - `ended_at IS NULL`
  - `COALESCE(updated_at, created_at) <= cutoff`
  - bounded mode whitelist
- UPDATE의 `changes===1`인 경우에만 연계 workflow stage를 실패 처리한다. 다른 프로세스가 직전에 완료한 행은 건드리지 않는다.
- 정상 완료/실패 UPDATE에도 `WHERE id=? AND status='active'`를 추가한다. sweeper가 먼저 `timed_out`으로 종결한 뒤 늦게 돌아온 실행이 `completed`로 덮어쓰지 못하게 한다. 현재 완료 UPDATE에는 이 guard가 없다 (`src/core/discussion-engine.ts:718-721`, `src/core/discussion-engine.ts:879-882`).
- provider 결과 저장 전 discussion이 여전히 `active`인지 확인한다. 이미 terminal이면 늦은 결과를 discussion message로 추가하지 않고 폐기 로그만 남긴다.
- 30분 cutoff는 heartbeat가 함께 배포된 경우에만 사용한다. heartbeat 없이 cutoff만 24시간→30분으로 낮추는 배포는 금지한다.

### 3. 되돌리기 쉬운 형태

- 새 상위 플래그: `NCO_DISCUSSION_RECOVERY_V2`
  - 기본: 단계적 canary 후 `1`
  - `0`: 주기 sweeper, provider heartbeat, 새 terminal 분류/CAS를 끄고 현재의 부팅 1회 `failStaleDiscussions()` + 24시간 `failed` 동작으로 복귀
- 기존 `NCO_DISCUSSION_STALE_TIMEOUT_MS`는 유지한다 (`src/core/workflow-gate.ts:548-555`).
- 새 `NCO_DISCUSSION_STALE_SWEEP_INTERVAL_MS`는 기본 60,000ms, 최소 10,000ms로 clamp한다.
- DB column 추가 없이 기존 `updated_at`, `ended_at`, `report`를 사용한다. 롤백에 down migration이 필요 없다.

### 4. 기존 계약 및 정상 세션 보호

- round-based 정상 종료의 `completed` 계약은 유지한다.
- timeout은 discussion 행에서만 `timed_out`으로 구체화하고, workflow stage에는 기존 `failed`를 유지하므로 workflow status union을 깨지 않는다.
- `realtime`은 sweeper에서 제외하므로 의도적으로 오래 열린 listener 세션을 종료하지 않는다.
- 실행 중 정상 session은 provider call 전/후 heartbeat를 기록하고, 최대 provider 상한 15분보다 긴 30분 cutoff를 사용하므로 정상 경로가 stale로 판정될 근거가 없다.
- 초기 릴리스는 provider 프로세스를 강제 종료하지 않는다. 위험은 “DB heartbeat가 30분 넘게 멈췄지만 실제 provider가 계속 정상 실행 중인 경우 논리 상태만 `timed_out`이 되는 것”이다. 이를 줄이기 위해 heartbeat+2배 cutoff+CAS를 한 묶음으로 배포한다.
- circuit breaker 임계치, cooldown, 상태 전이는 변경하지 않는다.

### 5. 검증 방법

#### 자동 테스트

1. `failStaleDiscussions()` 테스트를 확장한다 (`src/core/workflow-gate.test.ts:140-161`).
   - stale bounded active → `timed_out`, `ended_at` 설정
   - linked workflow stage → `failed/discussion_stale_timeout`
   - fresh bounded active → 변화 없음
   - stale `realtime` → 변화 없음
   - 이미 `completed/failed/timed_out` → 변화 없음
2. fake timer로 periodic tick이 2회 실행되는지, 중첩 tick이 차단되는지, `onClose` 후 실행되지 않는지 검증한다.
3. `startDiscussion()`에 timeout 예외와 일반 예외를 주입해 각각 `timed_out`/`failed`로 종결되는지 검증한다.
4. race 테스트:
   - sweeper가 `timed_out` 처리
   - 늦은 completion 실행
   - 최종 상태가 계속 `timed_out`이고 늦은 message가 추가되지 않음을 검증한다.
5. `NCO_DISCUSSION_RECOVERY_V2=0`에서 현재 one-shot/24시간/`failed` 동작으로 되돌아가는지 검증한다.

#### 운영 DB 증명 쿼리

```sql
-- cutoff를 넘긴 회수 대상은 0이어야 한다.
SELECT COUNT(*) AS unrecovered
FROM discussions
WHERE status='active'
  AND ended_at IS NULL
  AND mode IN ('task','parallel','discussion','consensus','hive','commander')
  AND datetime(COALESCE(updated_at, created_at)) <= datetime('now', '-30 minutes');

-- timed_out writer가 다시 동작했음을 직접 확인한다.
SELECT id, mode, status, report, updated_at, ended_at
FROM discussions
WHERE status='timed_out'
ORDER BY ended_at DESC
LIMIT 20;

-- workflow projection이 함께 종결됐는지 확인한다.
SELECT d.id, d.status AS discussion_status,
       ws.status AS stage_status, ws.error
FROM discussions d
JOIN workflow_stages ws
  ON ws.workflow_run_id=d.workflow_run_id
 AND ws.discussion_id=d.id
 AND ws.stage='discussion'
WHERE d.report='discussion_stale_timeout'
ORDER BY d.ended_at DESC;
```

완료 증거는 테스트 문자열이나 로그만이 아니라 위 행의 실제 상태/`ended_at`/workflow stage를 함께 확인해야 한다.

---

## 문제 B — 유계 없는 슬롯 acquire

### 1. 회수/해제 트리거

권고안은 **acquire 자체의 timeout을 주 경로**, **기존 부팅 orphan recovery를 crash 안전망**으로 사용한다.

1. 실제 `Semaphore.acquire()`에 선택적 timeout과 waiter 취소를 추가한다.
   - timeout 값은 새 별도 숫자를 만들지 않고 기존 `getQueueWaitMaxMs()`를 재사용한다. 기본값은 현재와 같은 1,800,000ms(30분)다 (`src/core/task-queue.ts:2041-2044`).
   - task metadata의 `queueWaitMaxMs`는 현재 BullMQ 대기 계산과 동일하게 global 상한 이하에서만 허용한다 (`src/core/task-queue.ts:1706-1711`).
2. 실제 두 호출점 모두 bounded acquire를 사용한다.
   - BullMQ `runJob()` (`src/core/task-queue.ts:1321-1335`)
   - semaphore fallback `enqueueSemaphore()` (`src/core/task-queue.ts:1829-1844`)
3. timeout waiter는 semaphore queue에서 실제 제거해야 한다. 단순 `Promise.race()`만 쓰면 timeout 뒤 남은 callback이 차후 permit을 소비해 새 slot leak을 만든다.
4. timeout 전에 slot이 나오면 기존대로 `startRuntime()`을 호출하고 lease를 발급한다.
5. 프로세스가 acquire 대기 중 죽으면 기존 `recoverOrphanedTasks()`가 `assigned`를 회수한다. 새 주기 DB sweeper는 추가하지 않는다.

`assigned AND lease_expires_at IS NULL`은 “고아”뿐 아니라 정상적인 pre-runtime queue waiter의 현재 표현이기도 하다. 별도 durable `slot_wait_started_at` 없이 이 조건만 주기 sweep하면 정상 대기 task를 오탐 종료하므로 금지한다.

### 2. 상태 전이 및 오탐 방지

- slot 획득 성공:
  - 기존 `assigned → running`
  - `acknowledgeTaskLease()`가 `acked_at`과 `lease_expires_at`을 기록
- slot acquire timeout:
  - `startRuntime()`을 호출하지 않음
  - error는 기존 failover 분류가 인식하는 `queue_wait_timeout: provider <id> slot busy for <ms>ms`로 통일
  - BullMQ worker는 `UnrecoverableError`로 해당 job을 종료해 BullMQ 내부 중복 retry를 막는다. 상위 enqueue/failover 경로는 error text를 받아 기존 정책을 수행한다.
  - semaphore fallback은 `{ success:false, error:'queue_wait_timeout: ...' }`를 반환한다.
  - 최종적으로 회복 후보가 없으면 gateway의 기존 terminal 처리에서 `assigned → failed`가 된다 (`src/server/gateway.ts:2231-2300`; `queue_wait_timeout`은 현재 `failed`로 분류됨: `src/server/gateway.ts:250-281`).
- timeout은 실행 중인 slot 보유 task를 abort하지 않는다. 대기 waiter만 제거한다.
- `entry.waiting`은 성공/timeout/예외 모두 한 번만 감소시킨다. acquire 실패 시 `release()`를 호출하지 않고, 실제 permit을 얻은 경우에만 기존 finally에서 release한다.
- error prefix는 현재 transient/team failover 판정과 외부 failover 분류가 이미 인식한다 (`src/core/task-queue.ts:430-449`, `src/server/task-failover.ts:45-80`).

### 3. 되돌리기 쉬운 형태

- 새 플래그: `NCO_BOUNDED_SLOT_ACQUIRE`
  - 기본: `1`
  - `0`: actual agent slot의 두 호출점만 기존 무기한 `acquire()`로 되돌림
- timeout 숫자는 기존 `NCO_QUEUE_WAIT_MAX_MS`와 task metadata `queueWaitMaxMs`를 재사용한다. 운영자가 이미 조정한 queue wait 계약을 이중 설정으로 갈라놓지 않는다.
- `Semaphore.acquire()`의 timeout 인자를 optional로 둔다. verifier build용 기존 acquire 등 비대상 호출은 인자 없이 현재 동작을 유지한다.
- schema/migration이 필요 없으므로 env rollback만으로 동작 복귀가 가능하다.

### 4. 기존 계약 및 정상 task 보호

- 현재 BullMQ queue도 active 진입 전 `NCO_QUEUE_WAIT_MAX_MS`를 적용한다 (`src/core/task-queue.ts:1728-1790`). 같은 상한을 local slot wait에도 적용하므로 새로운 더 짧은 큐 계약을 만들지 않는다.
- slot을 보유한 실행은 건드리지 않는다. acquire 전 waiter만 timeout하므로 정상 실행 중 CLI를 강제 종료하지 않는다.
- 정상 대기가 상한 전에 permit을 받으면 lease 발급과 실행 경로는 바뀌지 않는다.
- 위험은 “정상적으로 매우 긴 queue backlog가 30분을 초과하면 실행 대신 failover/failed로 종결되는 것”이다. 이는 무한 `assigned`보다 명시적이고 관측 가능한 실패를 택하는 변화다. 필요하면 기존 `NCO_QUEUE_WAIT_MAX_MS`를 올릴 수 있고, 긴급 롤백은 `NCO_BOUNDED_SLOT_ACQUIRE=0`이다.
- boot orphan recovery의 `orphan_requeue_count` 정책과 poison 상한은 변경하지 않는다 (`src/index.ts:55-56`, `src/index.ts:120-160`).
- lease duration/sweeper와 circuit breaker 임계치·cooldown은 변경하지 않는다.

### 5. 검증 방법

#### 자동 테스트

1. semaphore 단위 테스트:
   - concurrency=1의 permit을 점유
   - 두 번째 acquire가 fake timer의 설정 상한에서 timeout
   - 첫 permit release 후 세 번째 acquire가 즉시 성공
   - timeout waiter가 queue에 남아 permit을 먹지 않았음을 증명
2. semaphore fallback 통합 테스트:
   - 첫 task가 slot 점유
   - 두 번째 task는 timeout 후 `queue_wait_timeout` 실패
   - DB가 `assigned → failed`, `lease_expires_at IS NULL`, `orphan_requeue_count=0`
   - `entry.waiting=0`, active count/permit 누수 없음
3. BullMQ 통합 테스트:
   - worker concurrency와 local semaphore를 포화
   - `runJob()` acquire timeout이 job failed로 귀결
   - 상위 enqueue가 동일 error를 받고, 중복 BullMQ retry 없이 기존 failover를 1회 수행
4. 정상 경계 테스트:
   - timeout 직전에 slot release
   - waiter가 `running`으로 전이하며 `acked_at`과 `lease_expires_at`이 설정
   - 기존 실행 task는 abort되지 않음
5. restart 테스트:
   - `assigned + lease NULL` fixture
   - boot recovery가 `queued`로 바꾸고 `orphan_requeue_count`를 1 증가시킨 뒤 reenqueue
6. flag-off 테스트:
   - `NCO_BOUNDED_SLOT_ACQUIRE=0`에서 fake timeout을 넘겨도 waiter가 pending
   - 테스트가 직접 permit을 release한 뒤 정상 진행

#### 운영 DB 증명 쿼리

기본 30분 상한과 1분 관찰 여유를 기준으로 다음 첫 쿼리가 0이어야 한다.

```sql
SELECT COUNT(*) AS stale_prelease_waiters
FROM tasks
WHERE status='assigned'
  AND lease_expires_at IS NULL
  AND datetime(COALESCE(updated_at, created_at)) <= datetime('now', '-31 minutes');

SELECT id, assigned_to, status, error, updated_at,
       acked_at, lease_expires_at, orphan_requeue_count
FROM tasks
WHERE error LIKE 'queue_wait_timeout:%'
ORDER BY updated_at DESC
LIMIT 20;

SELECT id, assigned_to, status, acked_at, lease_expires_at
FROM tasks
WHERE status IN ('running','streaming')
ORDER BY updated_at DESC
LIMIT 20;
```

두 번째 쿼리는 timeout이 관측 가능한 terminal 상태가 됐음을, 세 번째 쿼리는 정상 획득 task가 실제 lease를 받았음을 함께 증명한다. 프로세스 존재나 로그 문자열만으로 완료 판정하지 않는다.

---

## 우선순위

**문제 B를 먼저 구현하고, 문제 A를 뒤이어 구현한다.**

이유:

1. B는 현재도 task 수가 4→7→8로 증가한 pre-runtime 자원 고착이며, 정확한 원인이 두 unbounded acquire로 한정된다.
2. B는 timeout waiter만 제거하므로 정상 실행 중 task를 강제 종료하지 않고, schema 변경 없이 작은 범위로 롤백할 수 있다.
3. A는 현재도 부팅 1회/24시간 회수 경로가 있어 완전 무방비는 아니다. 반면 안전하게 cutoff를 줄이려면 provider heartbeat, realtime 제외, CAS, late-result 차단을 한 묶음으로 설계해야 하므로 변경 면적과 오탐 위험이 더 크다.
4. 어느 안도 circuit breaker 임계치 변경을 전제하지 않는다.

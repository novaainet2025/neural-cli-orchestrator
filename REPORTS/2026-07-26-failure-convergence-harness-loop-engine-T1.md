# NCO 실패 수렴 하네스·루프 엔진 T1 보고서

- 기준 시각: 2026-07-26 19:33 KST
- 대상: NCO의 일반 태스크, 회사(company run), 팀 단계(stage), 토론·검토 작업
- 판정: **구현·회귀·실서비스 재기동 복구 검증 PASS**
- 보증 경계: 외부 CLI·모델·네트워크가 영구 불가한 상황에서 산출물 성공을 보장한다는 뜻이 아니다. 이 시스템이 보장하는 것은 **검증된 성공으로 수렴하거나, 유계 예산 안에서 실패 원인과 증거가 있는 명시적 종결 상태로 수렴하며, 재시작·저장 실패를 정상 성공으로 위장하지 않는 것**이다.

## 1. 최종 실행 모델

```text
요구사항
  → 입력 계약/프로바이더 적합성 검사
  → circuit + rate-limit 기반 가용성 라우팅
  → 단일 실행 큐(BullMQ attempts=1)
  → 회사/팀 단계 실행
  → 응답 계약·품질 검증
  → 성공: verified completed
  → 실패: 분류된 failover + 6시간/평생 retry budget
  → 회사 Gap: 다음 bounded iteration
  → 프로세스 재시작: SQLite snapshot reconcile/resume
  → 예산 소진·정책 실패: partial/failed + 증거 영수증
```

### 유계 조건

| 제어면 | 한도/정책 |
|---|---|
| 회사·하네스 반복 | 기본 5회, 요청 가능 1~10회, 절대 상한 10회 |
| 재시작 복구 | 별도 resume budget 3회 |
| 단계 실행 | 팀 lead/member failover, 단계별 bounded attempts |
| 일반 태스크 retry | 6시간 창 3회, 평생 10회 |
| BullMQ 자체 재실행 | `attempts=1`; 앱 레벨 정책만 재시도 권한 보유 |
| active orphan | 재기동 복구 2회 후 poison dead-letter |
| queued orphan | 실행된 적 없는 대기 작업이므로 poison budget을 소비하지 않고 재큐 |
| 회로 half-open | 실제 half-open 진입 시각부터 TTL·probe slot 적용 |

## 2. 구현 결과

### Durable company/harness

- `company_runs`, `harness_runs`, 호환 `harness_reports` 영속 저장소를 마이그레이션 090으로 추가했다.
- 모든 회사 실행은 최초 durable snapshot 기록이 실패하면 `503`으로 시작을 거부한다.
- 실행 중 snapshot 기록이 실패하면 드라이버가 추가 외부 작업을 중단하고 best-effort 실패 기록만 시도한다.
- 부팅 시 nonterminal company run을 먼저 복원·태스크 상태와 reconcile한 뒤, harness tracker를 같은 ID로 복원한다.
- 프로세스 내 `ACTIVE_RUN_DRIVERS`로 동일 run의 이중 드라이버를 차단한다.
- 실행 iteration과 restart resume 횟수를 분리했다. 크래시 중간 재개는 실제 실행 iteration을 선소비하지 않는다.
- 하네스 REST API를 추가했다.
  - `POST /api/harness`
  - `GET /api/harness`
  - `GET /api/harness/:harnessId`
- 완료 판정은 모든 stage가 `completed`이고 completion score가 100일 때만 `converged=true`다. `skipped`, 불충분 출력, provider 실패는 성공으로 승격하지 않는다.
- 터미널 보고서의 `updatedAt`/`completedAt`은 재조회해도 바뀌지 않는다.

### Queue·orphan·shutdown

- terminal DB task가 stale BullMQ job으로 남아도 `UnrecoverableError`로 재실행하지 않는다.
- BullMQ retry를 1회로 고정하고 앱 retry budget과 이중 재시도를 제거했다.
- 부팅 시 stale terminal jobs를 정리하고 SQLite가 권위 저장소가 되도록 했다.
- SIGINT/SIGTERM에서 API 신규 요청을 먼저 닫고 in-flight drain, queue/WS/Redis/SQLite 순으로 종료한다.
- 종료 도중 CLI exit 130/143/`AbortError`는 unrelated provider failure로 오분류하지 않는다.
- 실제 대기 작업을 poison으로 오판해 dead-letter한 초기 결함을 발견했고, queued와 active 복구 정책을 분리해 수정했다.

### Routing·failover·quality

- active rate-limit 판정을 공유 SQL로 단일화했다. `is_limited=1`이면서 미래 `reset_at`이 있는 경우만 active다. 만료·NULL legacy row는 영구 차단하지 않는다.
- 인증/쿼터 같은 indefinite 제한의 권위는 circuit registry로 통일했다.
- 미분류 `status=error`와 transport failure는 silent-drop하지 않고 `transient`로 분류한다.
- `cancelled`, policy/format rejection은 provider failover하지 않는다.
- quality rejection을 받은 원 태스크는 `completed`에 남겨 두지 않고 응답을 보존한 채 `failed`로 강등한 후 retry를 만든다.
- 구조화 JSON-only 프롬프트에는 빌드 지시를 주입하지 않는다.
- retired-media-provider는 media 작업에만 참여한다.

### Discussion·collaboration

- R1 제안이 하나도 성공하지 않으면 토론을 완료로 위장하지 않고 실패시킨다.
- 결론은 임의 UUID/첫 응답이 아니라 R3 synthesis를 사용한다.
- synthesis 실패 시에만 R2 평가로 계산한 winner를 사용한다.

## 3. Conductor 교차검토 영수증

- NCO task: `task_-R6qSBCRSQolPu78`
- Discussion: `sess_tvDIBUa_iwH02gIM`
- Mode: `parallel`, 3 rounds
- 독립 검토자: `cursor-agent`, `opencode`, `agy`
- R3 synthesis: `claude-code`
- 상태: `completed`
- consensus: `0.8`
- 최종 응답: 1,707자 실제 synthesis 문서

검토 결과는 그대로 채택하지 않고 소스와 부팅 순서로 재검증했다.

- 실제 Gap으로 채택·수정:
  - rate-limit SQL 분열/NULL 영구 차단
  - 미분류 오류 silent-drop
  - resume iteration 선소비
  - JSON-only 프롬프트 빌드 지시 충돌
  - durable 저장 실패 묵살
  - quality-rejected task의 거짓 `completed`
  - circuit half-open TTL 기준 시각
- 오탐으로 기각:
  - `resumeCompanyRuns()`가 queue 초기화보다 먼저 실행된다는 주장
  - retryCount가 구현되지 않았다는 주장

## 4. T1 검증 영수증

### 자동 회귀

```text
npm run test:run
Test Files  107 passed (107)
Tests       554 passed (554)
Duration    3.37s

npm run build
tsc PASS

git diff --check
PASS
```

새로 고정한 대표 회귀는 다음과 같다.

- 미래/만료/NULL rate-limit 실제 SQLite 판정
- retry 3회/6시간 창/평생 10회/예약 rollback
- queued vs active orphan poison budget
- resume budget과 completed iteration 분리
- circuit open→half-open TTL
- quality-rejected completed 강등
- unknown error transient failover
- structured JSON prompt verifier enrichment 예외
- terminal queue duplicate execution 방지
- shutdown cancellation 분류
- harness fail-close, partial, skipped, migration idempotence
- terminal harness timestamp 불변성

### 실제 성공 수렴

임시 text-only Hermes 팀으로 실제 하네스를 실행했다.

| 영수증 | 값 |
|---|---|
| Harness | `harness_Xm36RH-fhfZ5rHQ4` |
| Company run | `corun_IFPgeaZPGFpkFe6V` |
| Task | `task_FZXLk38eu8_zZXQ7` |
| 결과 | iteration 1, score 100, converged true |
| 출력 | 334자 |
| retry | 0 |

### 실제 프로세스 장애 주입·복구

두 번째 하네스를 `decomposing` 상태에서 PM2로 재기동했다.

| 영수증 | 값 |
|---|---|
| Harness | `harness_vOU0dFRXfQ9oNSKi` |
| Company run | `corun_FJinYo8qxfX8p11F` |
| Task | `task_WZGNCLGIRx5fDxrt` |
| 부팅 복구 로그 | `companyRuns:1`, `harnessRuns:1` |
| 결과 | 같은 ID 유지, iteration 1/2, score 100, converged true |
| 출력 | 324자 |
| retry | 0 |

최종 배포 후 동일 하네스를 1초 간격으로 두 번 조회했다.

```text
updatedAt   2026-07-26T10:31:09.132Z → 동일
completedAt 2026-07-26T10:31:09.132Z → 동일
timestampsStable=true
```

### 실제 queue 재기동

- 최종 부팅 PID: `56720`
- PM2: `online`, unstable restarts `0`
- Health: `healthy`, Redis `true`, agents online `9`
- 부팅 orphan: `requeue=1`, `deadLetter=0`, `reEnqueued=1`
- 보존 확인 작업: `task_6ci73xF9VPR75NHu`
  - 재기동 전/후 `queued`
  - `orphan_requeue_count=1` 유지
  - 관련 dead-letter `0`
- 마이그레이션:
  - `089_failure_reliability.sql` 적용
  - `090_durable_harness_runs.sql` 적용

## 5. 정리 및 운영 경계

- 장애 주입용 임시 조직 `org_harness-smoke-20260726`과 팀 `team_harness-smoke-text-20260726`은 두 실행이 terminal이 된 뒤 정확한 ID로 삭제했고, 조직·팀 잔존 수 0을 확인했다.
- 초기 검증에서 잘못 생성된 exact dead-letter 1건은 원 태스크를 정확히 복원한 뒤 해당 행만 제거했다. 다른 사용자의 태스크·변경·보고서는 수정하거나 정리하지 않았다.
- 작업트리는 이 작업 이전부터 여러 세션의 미커밋 변경이 섞인 dirty 상태다. 본 작업은 커밋·reset·clean을 하지 않았고 관련 없는 변경을 보존했다.
- 현 운영 감사에는 최근 24시간의 기존 실패·timeout 169건과 오늘 누락/기한초과 업무보고 74건이 남아 있다. 이는 이번 두 하네스의 실패가 아니며, 본 보고서는 그 역사적 backlog가 자동으로 해결됐다고 주장하지 않는다.
- 외부 provider가 모두 영구 불가하거나 요구사항 자체가 모순이면 성공 산출물을 만들 수 없다. 이 경우의 올바른 시스템 결과는 무한 루프나 거짓 성공이 아니라 `partial`/`failed` + 원인·attempt·stage 증거다.

## 6. 최종 판정

NCO의 일반 태스크와 모든 회사/팀 실행 경로에 대해 다음 조건을 만족한다.

1. 입력·가용성·정책 위반을 실행 전에 차단한다.
2. 실행과 재시도 권한을 단일 정책 계층에서 유계로 관리한다.
3. 품질 반려를 성공으로 표시하지 않는다.
4. 재시작 후 같은 durable run을 이어가며 중복 드라이버를 만들지 않는다.
5. 저장소가 불가하면 durable하다고 거짓 주장하지 않고 fail-close한다.
6. 성공/부분/실패를 API와 SQLite 영수증으로 관찰할 수 있다.

따라서 **“어떤 외부 조건에서도 무조건 성공”이라는 검증 불가능한 약속이 아니라, “성공 또는 증거 있는 명시적 실패로 반드시 수렴하고 조용한 유실·무한 재시도·거짓 완료를 허용하지 않는 실패 수렴 하네스”가 구성·실행·장애 주입·검증되었다.**

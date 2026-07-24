# Team 06 Improvement Debate 중복 오류·False Report 교차검증

> 대상: `team_tech-port-06-improvement-debate`
> HR 지시 스냅샷: `tle_C9lxPO6T-5gVbjFM`, 2026-07-24 02:30:00 UTC
> 추출 시각: 2026-07-24 11:57:20 KST
> cycle 3/3 자가학습 재검증: `task_z37_iciA60pQgk37`,
> 2026-07-24 03:05:05 UTC DB 스냅샷
> T1 원본: `/Users/nova-ai/project/nco/db/nco.db`의 `tasks`,
> `retry_counts`, `agent_actions`, `agent_invocations`, `verification_gates`,
> `false_reports`, `hourly_role_audits`, `logs`, `circuit_states`,
> `team_lifecycle_events`와 Git 파일·커밋
> 안전 경계: 이 조사에서는 팀 활성 상태·라이프사이클·은퇴 상태를 변경하지
> 않았고, 기존 task 행과 점수도 수정하지 않았다.

## 판정 요약

- HR 지시 이벤트의 원문은 `score=64.5`, `sample=48h/11`,
  `completion=63.6%`다. 같은 시각의 scorer 표본은 완료 7, 실패성 4로
  `7/11=63.6%`와 일치한다. score는 이 문서에서 다시 만들어내지 않고
  저장된 HR 스냅샷을 인용한다.
- 실패성 4건 중 3건은 같은
  `workReportId=wr_JIBVlr-DEZl9JBGS`, 완전히 같은 prompt를 가진
  `opencode` 업무보고가 6초 안에 중복 생성된 뒤 모두 `lease_expired`된
  것이다. 세 태스크 모두 ack 뒤 heartbeat가 한 번도 없고 `tasks.response`도
  비어 있다. 다만 `agent_actions`에는 만료 확정 2분 15초~3분 17초 뒤
  `opencode`가 329~1,000자의 출력을 보낸 기록이 있다. 즉 실제 패턴은
  완전 무응답이 아니라 늦게 도착한 출력이 task 결과에 채택되지 않은 것이다.
- 나머지 실패 1건 `task_eTYAEfE-U8SP4X8F`는 목표·성과보고 HTTP POST가
  `localhost:6200` 연결 거부로 실패한 인프라 오류다. DB의 일반 오류 분류는
  `unknown: failure pattern in output`이지만 응답 본문에 두 POST의
  `curl: (7)`과 `HTTP_STATUS:000`이 남아 있다.
- raw 완료 7건 중 3건은 `qualityRejected=true`,
  `qualityHeuristics=["FORMAT_MISMATCH"]`다. 세 건 모두 build verifier는
  통과했지만 응답 첫 줄이 `done:|status:|question:|error:` 계약을
  만족하지 않았다.
- 위 3개 품질 반려 부모는 retry child 4개를 만들었다. 한 child가 다시
  `FORMAT_MISMATCH`가 됐고, 나머지 3개는 서버 재시작 orphan으로 실패했다.
  `EMPTY_OR_SHORT`는 대상 11건과 이 품질 retry 4건에서 0건이다.
- `computeTeamScores`는 `qualityRejected`를 읽지 않으므로
  `FORMAT_MISMATCH`가 score 64.5를 직접 낮춘 것은 아니다. 직접 score 저하
  원인은 terminal 분모의 실패 4건이며, 형식 반려는 retry 부하와 보고 신뢰도
  문제다.
- 현재 개선 사이클의 자가학습·자가개선 부모도 각각
  `FORMAT_MISMATCH`이고 `evidence_json`이 없다. 자가개선 응답은 대상도
  Team 06이 아니라 Team 05를 설명해 요청한 patch·검증 영수증을 제공하지
  않았다.
- Team 06을 직접 가리키는 최근 48시간 `hourly_role_audits`, `logs`,
  `false_reports` 행은 모두 0건이다. 따라서 승인된 auto-audit 판정이나
  CB 룰 번호는 **데이터 부재**이며 번호를 만들지 않는다.

`localhost:6200`은 조회 시 연결 거부 상태였다. `nco_list_tasks`와
`nco_get_task` HTTP wrapper 대신 같은 API의 원천 저장소인 `db/nco.db`를
읽기 전용으로 조회했다. API 동작과 운영 재실행은 `[미검증]`이다.

## (a) 반복 오류 빈도표

### HR 48시간/11 표본

| 오류 시그니처 | 빈도 | T1 task_id | DB 원문·실패 스니펫 | score 관계 |
|---|---:|---|---|---|
| 동일 업무보고 중복 뒤 `lease_expired` | 3 | `task_xn-WyOVjIHSEgnD0`, `task_T42Cd0mgElSOaoXU`, `task_WHn4No9eM_HH6WJQ` | 같은 workReportId·prompt hash, 생성 `00:05:08`·`00:05:08`·`00:05:14` UTC, `heartbeat_seq=0`, `tasks.response_len=0`, 세 건 모두 `00:06:46` 만료 확정. 그러나 `agent_actions`에는 `00:09:01`~`00:10:03` UTC에 늦은 출력이 존재 | terminal 실패 3건으로 직접 포함 |
| NCO gateway 연결 거부 | 1 | `task_eTYAEfE-U8SP4X8F` | `curl: (7) Failed to connect to localhost port 6200`, `HTTP_STATUS:000`; DB error는 `unknown: failure pattern in output` | terminal 실패 1건으로 직접 포함 |
| 완료 상태의 `FORMAT_MISMATCH` | 3 | `task_9NxxNDRueeHKplTB`, `task_Pe00dCrVyKbbWFcM`, `task_zpPvDFRqCqWu4NUE` | 각각 “`createFile` function…”, “`editFile` function…”, “6단계 개선 방향 토론…”으로 시작; protocol prefix 없음; build exit 0 | raw 완료에 포함되므로 현재 score에는 직접 영향 없음 |
| `EMPTY_OR_SHORT` | 0 | 해당 없음 | `metadata_json.qualityHeuristics` 직접 집계 | 관측 근거 없어 CB 조건으로 사용 금지 |
| 구조화 근거 부재 | 11 | 표본 전체 | `evidence_json` NULL/빈 값 | 신뢰도 Gap; 현재 score 식에는 직접 영향 없음 |

scorer의 현재 11건은 `completed=7`, `failed=1`, `lease_expired=3`이다.
취소 1건은 terminal 표본 밖이며, commit `e6efcf1`이 서버 재시작 orphan
`task_1SAeDCVfMO8FDlBz` 한 건을 terminal 분모에서 제외해 종전
12건/58.3%를 11건/63.6%로 교정했다.

`metadata_json.round`는 11건 모두 NULL이다. 따라서 “몇 번째 debate
round에서 중단됐는가”는 DB로 판정할 수 없다. 아래에서는 만들어내지 않은
round 번호 대신 parent/retry 깊이만 보고한다.

### cycle 3/3 자가학습 재검증 — 에이전트·중단 지점

아래 집계의 에이전트는 HR scorer와 같은 `tasks.assigned_to` 최종값이다.
`qualityRejected`는 raw `completed`와 별도로 표시했다.

| 기록 에이전트 | 표본 | raw 완료 | 실패성 | `FORMAT_MISMATCH` | raw 완료율 |
|---|---:|---:|---:|---:|---:|
| `opencode` | 4 | 1 | 3 | 0 | 25.0% |
| `nvidia` | 3 | 3 | 0 | 2 | 100.0% |
| `hermes` | 2 | 1 | 1 | 0 | 50.0% |
| `claude-code` | 1 | 1 | 0 | 1 | 100.0% |
| `cursor-agent` | 1 | 1 | 0 | 0 | 100.0% |
| 합계 | 11 | 7 | 4 | 3 | 63.6% |

실패성 4건의 실제 중단 지점은 다음처럼 재현된다.

| task_id·시각(UTC) | 실행 계보 | DB 실패·출력 스니펫 | 판정 |
|---|---|---|---|
| `task_T42Cd0mgElSOaoXU` · 생성 `00:05:08`, 만료 확정 `00:06:46` | `agent_invocations`의 `claude-code` 호출은 935ms 안에 `Circuit breaker open…`으로 실패; 최종 `tasks.assigned_to=opencode`; heartbeat 0 | `agent_actions` `00:09:01`: “`## 2026년 7월 24일 오전 업무보고`…” 1,000자 | 만료 확정 135초 뒤 출력 도착, task 결과에는 미채택 |
| `task_xn-WyOVjIHSEgnD0` · 생성 `00:05:08`, 만료 확정 `00:06:46` | `claude-code` 호출은 1,245ms 안에 같은 circuit 오류; 최종 `opencode`; heartbeat 0 | `agent_actions` `00:09:28`: “`done: [Evidence Tier 1] 파일 저장 확인`…” 329자 | 만료 확정 162초 뒤 출력 도착, task 결과에는 미채택 |
| `task_WHn4No9eM_HH6WJQ` · 생성 `00:05:14`, 만료 확정 `00:06:46` | `claude-code` 호출은 283ms 안에 같은 circuit 오류; 최종 `opencode`; heartbeat 0 | `agent_actions` `00:10:03`: “먼저 기존 보고서 저장 디렉토리…” 뒤 `done:` 보고 559자 | 만료 확정 197초 뒤 출력 도착, task 결과에는 미채택 |
| `task_eTYAEfE-U8SP4X8F` · 생성 `2026-07-23 11:43:43`, 실패 `11:47:28` | `hermes`, heartbeat 16 | “`curl: (7) Failed to connect to localhost port 6200`”, `HTTP_STATUS:000` | debate round가 아니라 제어면 HTTP 입력 단계에서 중단 |

따라서 “debate 몇 번째 라운드에서 EMPTY로 중단”이라는 가설은 이 표본으로
입증되지 않는다. `round`가 전부 NULL이고 `EMPTY_OR_SHORT`도 0건이다.
관측된 중단은 debate 내부 라운드가 아니라 dispatch/lease 단계 3건과 NCO
제어면 HTTP 단계 1건이다.

### `FORMAT_MISMATCH`를 만든 prompt/response 계약

세 형식 반려 모두 prompt 구조가
`[이전 단계 산출물] → [회사 목표] → [팀 하위작업] → 자동 보강` 순서였고
`verifier_json={"type":"run","command":"npm run build",...}`가 붙어 있었다.
그러나 prompt에는 첫 줄 protocol prefix가 요구된다는 문장이 없었다.
완료 처리 시 verifier 존재만으로
`requireProtocolPrefix=true`가 되어 다음 응답을 반려했다.

| task_id | prompt/응답 관측 | 반려 스니펫 |
|---|---|---|
| `task_9NxxNDRueeHKplTB` | 1,278자 prompt 앞부분이 이전 단계의 `createFile` 설명; 응답도 현재 토론 대신 함수 오류 설명 | “`In this case, the createFile function is used…`” |
| `task_Pe00dCrVyKbbWFcM` | 위와 동일한 1,278자 prompt; 응답은 `editFile` 함수 설명 | “`The editFile function is used to edit…`” |
| `task_zpPvDFRqCqWu4NUE` | 2,757자 prompt에 이전 단계 분석과 Team 06 지시가 결합; 실제 6단계 보고는 작성했으나 첫 줄 prefix 없음 | “`6단계 개선 방향 토론을 산출물로 작성했습니다.`” |

T1 근거상 직접 원인은 내용 길이나 `EMPTY`가 아니라, build verifier가 붙은
태스크에만 암묵적으로 요구되는 `done:|status:|question:|error:` 계약이
입력 prompt에는 없다는 불일치다. 앞의 두 nvidia 응답에는 이전 산출물의
도구 설명을 현재 작업 결과로 반복하는 별도 내용 불충족도 함께 있다.

### 근본원인과 제한적 개선 가설

1. **완료율 직접 원인 — T1:** 동일 `workReportId`의 물리 task 3개가
   중복 생성되고, 최초 `claude-code` circuit 실패 뒤 `opencode` 출력이
   heartbeat 없이 lease 만료 뒤 도착해 모두 실패로 집계됐다. 활성
   work-report idempotency gate는 commit
   `e0a786f54437a91c45602080cc3f09c9e1bfa2bf`와 migration 100으로 이미
   적용돼 있다. 실패는 적용 전 `00:05` UTC, migration 적용은 `02:22:50`
   UTC이므로 사후 48시간 실패율 감소는 아직 **[미검증]**이다.
2. **형식 반려 직접 원인 — T1:** verifier가 있으면 output prefix를
   요구하지만 Team 06 prompt에는 그 계약이 없다. Team 06 또는
   `diagnosticTargetTeamId`에만 intake response contract를 opt-in하는
   수정이 가장 좁다. prompt marker와 단위 테스트만 제거하면 되돌릴 수
   있다. 후속 자가개선에서 `src/server/task-intake.ts`와 회귀 테스트에
   이 범위의 계약을 적용했으며 과거 task 상태·점수는 수정하지 않았다.
3. **late output 개선 — T1 관측/T2 가설:** 세 task 모두 late output이
   있으므로 provider별 임대 시간을 무조건 늘리기 전에, heartbeat 누락
   원인과 만료 뒤 `task:completed` 이벤트의 폐기/조정 정책을 계측해야 한다.
   독립 workReport 표본이 1개뿐이어서 새 timeout 수치는 제안하지 않는다.

### 품질 반려 parent → retry 계보

| parent | parent 응답·품질 | retry_count | child 결과 |
|---|---|---:|---|
| `task_9NxxNDRueeHKplTB` | 함수 설명 134자, `FORMAT_MISMATCH` | 1 | `task_j6O2YRNwMhFiro6v` — orphan 실패 |
| `task_Pe00dCrVyKbbWFcM` | 함수 설명 311자, `FORMAT_MISMATCH` | 1 | `task_BmCsS7jRRxVw9C8w` — orphan 실패 |
| `task_zpPvDFRqCqWu4NUE` | 실질 보고 1,474자이나 prefix 없음, `FORMAT_MISMATCH` | 2 | `task_cosLmbEuYLUmLobv` — completed지만 다시 `FORMAT_MISMATCH`; `task_Z_Fch_86xWW18MZe` — orphan 실패 |

retry child 4건은 모두 `team_id=NULL`이므로 HR의 Team 06 11건에 합산하지
않는다. 다만 같은 품질 반려가 한 번 더 새 task를 만들고 이후 orphan 실패까지
증폭한 계보 증거로는 사용한다.

### 현재 improvement cycle 3/3의 별도 교차검증 표본

아래 세 task는 Team 06의 11건 표본이 아니라 개선 파이프라인 팀의 부모다.
그러나 현재 요청이 이어진 경로에서 같은 gate 문제가 재현됐으므로 별도로
기록한다.

| 단계 | task_id | raw 상태 | 응답 | 품질·검증 |
|---|---|---|---|---|
| 자가학습 | `task_CbJGtiVK9F6p7Kgh` | completed | `searchFiles` 사용법과 `self-improve/*` 탐색 계획만 설명 | `FORMAT_MISMATCH`; build exit 0; evidence 없음; retry 1 |
| 자가개선 | `task__HpdDOivnig90qob` | completed | 엉뚱한 `team_tech-port-05-upgrade-regression/*` 탐색 설명 | `FORMAT_MISMATCH`; build exit 0; evidence 없음; retry 1 |
| 최초 오류방지 | `task_QIwzcKS61Sqdly38` | completed | `searchFiles` 호출 설명 152자 | `FORMAT_MISMATCH`; build exit 0; evidence 없음; retry 1 |

세 부모 모두 default build verifier가 붙어
`src/server/gateway.ts:1168-1170`의 `requireProtocolPrefix=true` 경로로
들어갔다. 그러나 prompt에는 이 prefix 계약이 없다. 실제 형식 판정은
`src/verification/response-quality.ts:80-90`이고, intake의 명시적 팀 계약은
현재 `src/server/task-intake.ts:30-74`의 Team 01에만 한정돼 있다.

## auto-audit·CB 데이터 경계

HR 스냅샷 이전 최근 48시간의 Team 06 직접 참조 행은 다음과 같다.

| 소스 | 관측 행 |
|---|---:|
| `hourly_role_audits` | 0 |
| `logs` | 0 |
| `false_reports` | 0 |
| `verification_gates` | 39 |
| `agent_invocations` | 13 |

`verification_gates` 39건은 대상 task 13건(취소·orphan 포함)의 L1/L2/L3
상태이며 승인된 auto-audit/False Report 판정이나 CB 규칙 레지스트리가
아니다. `circuit_states`는 현재 provider 상태만 보존하고 역사 이력을
보존하지 않는다. 따라서 아래 이름은 설명용이며 정식 룰 ID가 아니다.

### 동시 생성된 중복 산출물 교차검증

검증 도중 이 조사와 별도 소유의
`data/error-prevention/tech-port-06-gate-update-2026-07-24.json`과
`tech-port-06-cross-verification-2026-07-24.md`가 새로 나타났다. 중복 작업을
숨기지 않고 내용을 대조했으며, 다음 이유로 본 보고의 T1 근거로 채택하지
않았다. 해당 파일은 수정·삭제·stage하지 않았다.

| 중복 산출물 주장 | DB·Git 재검증 | 판정 |
|---|---|---|
| Team 06 task 계층 `FORMAT_MISMATCH=0` | heuristic은 `error`나 `response`가 아니라 `metadata_json.qualityHeuristics`에 저장된다. HR 표본 parent 3건, retry child 1건에서 직접 확인 | 쿼리 대상 열 오류로 인한 false negative |
| `GATE-06-R1`~`R3` 정식처럼 보이는 ID | `hourly_role_audits`, `logs`, `false_reports` 직접 참조 0건이고 승인된 rule registry 근거 없음 | 사용자 제약상 번호 채택 금지 |
| 패치 후 completion `7/10=70.0%` | 이는 e6efcf1 이후 worktree의 미커밋 gateway-down 추가 제외까지 적용한 후보 계산이다. HR 지시 스냅샷은 `7/11=63.6%`이며 운영 재계산 70.0%는 없음 | 후보 시뮬레이션과 관측 지표 혼동 |
| 현재 자가개선 patch가 genuine fix | 실제 현재 자가개선 `task__HpdDOivnig90qob` 응답은 Team 05 함수 설명이며 patch/evidence가 없다. e6efcf1은 그 task보다 11분 먼저 존재 | 검증 대상 task 불일치 |

중복 산출물의 “gateway 연결 거부는 인프라”라는 행 분류 자체는 DB 본문과
일치한다. 그러나 source ownership·commit·운영 반영이 확인되지 않은
미커밋 후보를 완료된 현재 개선으로 보고하거나, 잘못된 열을 조회해
`FORMAT_MISMATCH=0`으로 결론 내릴 수는 없다.

## (b) Circuit Breaker·Gate 갱신안

### 활성 work-report idempotency gate — 구현됨, 재구현 금지

- 적용 조건: `metadata.workReportId`가 있고 같은 ID의 task가
  `pending|queued|assigned|running|streaming|reviewing` 상태일 때.
- 동작: 새 task 대신 기존 task를 반환하고, DB 부분 unique index가 동시
  insert 경쟁을 차단한다. terminal 뒤 명시적 retry는 허용한다.
- 근거: 논리적 오전 보고 1건이 물리 task 3건으로 생성돼 같은 lease 실패
  3건으로 증폭됐다.
- 현재 상태: commit `e0a786f54437a91c45602080cc3f09c9e1bfa2bf`,
  migration `085_active_work_report_task_idempotency.sql`; DB migration id
  100이 2026-07-24 02:22:50 UTC에 적용됐고
  `idx_tasks_active_work_report_id`가 존재한다. 관측 실패
  2026-07-24 00:05 UTC보다 뒤에 적용됐다.
- 되돌리기: gateway/task-intake의 idempotency hunk와 테스트를 되돌리고,
  승인된 migration rollback에서 index만 제거한다. task 데이터는 삭제하지
  않는다.
- Gap: API가 내려가 있어 실제 동시 HTTP 요청의 deduplicated 응답은
  재검증하지 못했다.

### Team 06 verifier-response contract gate — 적용·로컬 검증

- 적용 조건: `metadata.teamId=team_tech-port-06-improvement-debate` 또는
  명시적 `metadata.diagnosticTargetTeamId`가 이 팀이고 prompt에 동일
  marker가 없을 때만 opt-in한다.
- 동작: intake에서 marker를 한 번만 붙여, 완료 시 첫 줄 `done:`, 미완료·
  데이터 부재 시 첫 줄 `status:`와 `[미검증]`을 요구한다. 개선 task에는
  변경 경로·검증 명령과 결과·Gap·되돌리기를 요구한다. 도구 사용법이나
  이전 출력 echo는 산출물로 인정하지 않는다.
- 근거: 원 Team 06 완료 3건과 현재 개선 부모 3건 모두 verifier-backed였지만
  prefix 계약이 prompt에 없었고 모두 `FORMAT_MISMATCH`였다.
- 안전성: score·task 상태를 소급 수정하지 않고 입력 계약만 결정론적으로
  보강한다. Team 01 계약 패턴을 target metadata 범위로만 일반화한다.
- 검증: direct team, diagnostic target, retry 중복 방지, 다른 팀 무변경
  케이스를 `src/server/task-intake.test.ts`에 추가했다. 관련 3개 테스트
  파일 28개 케이스와 타입체크·빌드가 통과했다.
- 되돌리기: Team 06 marker/분기와 단위 테스트만 제거하면 기존 intake로
  복귀한다.

### 동일 heuristic quality-retry hold — 제안, 미구현

- 적용 조건: 같은 logical root에서 corrective retry 1회가 이미
  `FORMAT_MISMATCH`로 끝났고, 새 응답에도 protocol prefix 또는 요구
  evidence가 없을 때.
- 동작: 현재 root별 전역 cap 3을 늘리지 않고 후속 child 생성을 hold한다.
  누락 필드와 마지막 heuristic을 기록한 뒤 사람이 검토하거나 prompt 계약을
  보강할 때까지 surface한다.
- 근거: `task_zpPvDFRqCqWu4NUE`의 첫 child가 다시
  `FORMAT_MISMATCH`였는데도 두 번째 child가 생성됐고, 결국 orphan 실패가
  추가됐다. 현재 `gateway.ts:1185-1215`는 가용 provider를 바꾸지만 같은
  heuristic의 반복 여부로 조기 중단하지 않는다.
- 되돌리기: logical-root/heuristic hold 분기와 테스트만 제거해 기존 cap 3
  흐름으로 돌아간다.

### opt-in evidence completion gate 사용 — 기존 기능 활용 제안

- 적용 조건: patch/diff, rollback, typecheck와 관련 vitest를 명시한
  자가개선 task를 만들 때만 `requiredEvidence`를 선언한다.
- 동작: `evidence_json`의 변경 경로, diff/commit, 명령·exit code, rollback
  항목이 없으면 build 성공만으로 완료 채택하지 않는다. 일반 텍스트 토론에는
  적용하지 않는다.
- 근거: `task__HpdDOivnig90qob`는 build exit 0이지만 patch·vitest·rollback
  증거가 전혀 없고 `evidence_json`도 비어 있다.
- 현재 상태: `src/security/evidence-gate.ts`와 gateway/task-queue의
  `requiredEvidence` opt-in gate는 이미 존재한다. 새 gate를 만들지 말고
  task 생성 측에서 명시적으로 켜는 안이다.
- 되돌리기: 해당 task template의 `requiredEvidence` 선언만 제거한다.

### provider CB threshold — surface & hold

lease 실패 3개는 독립 작업 3개가 아니라 동일 workReport의 물리 중복이다.
이를 3회 독립 provider 실패로 세어 circuit을 여는 것은 잘못된 집계다.
auto-audit 역사와 독립 workReport별 lease 분포가 0건이므로 숫자 threshold,
cooldown, 정식 CB 번호는 제안하지 않는다. 먼저 idempotency gate 이후의
고유 workReport 단위 lease 이력을 수집해야 한다.

## (c) 자가학습·자가개선 False Report 교차검증

공식 `false_reports` 행은 두 task 모두 0건이다. 따라서 악의적 허위나 공식
False Report 확정 판정은 보류하고, 요청 충족도와 증거 등급만 판정한다.

### 자가학습 `task_CbJGtiVK9F6p7Kgh` — 불충족 / T4

| 확인 항목 | T1 관측 | 판정 |
|---|---|---|
| raw 상태·품질 | `completed`, `qualityRejected=true`, `FORMAT_MISMATCH` | executor 종료일 뿐 품질 PASS 아님 |
| 응답 | `searchFiles` 사용법과 앞으로 할 분석을 설명 | 실제 task_id·시각·실패 스니펫·빈도·노트 경로 없음 |
| verifier | `npm run build`, exit 0 | 저장소 typecheck만 증명; DB 분석·노트 내용을 검증하지 않음 |
| 증거 | `evidence_json=NULL` | T1 task 근거 없음 |
| retry | `retry_counts=1`, child `task_z37_iciA60pQgk37` running (DB 재조회 `2026-07-24 03:11:52 UTC`) | 현재 교정 task이므로 최종 결과 미확정 |

응답 내용은 자연어 계획뿐이므로 요청된 root-cause 보고의 증거 등급은 T4다.
기존 `vault 01-AGENTS/self-learning/tech-port-06-rootcause-2026-07-24.md`는
이전 cycle의 후속 Codex 작업으로 실제 존재하지만, 이번 task가 그 파일을
검증·갱신했다는 증거로 소급하지 않는다.

### 자가개선 `task__HpdDOivnig90qob` — 불충족 / T4

| 확인 항목 | T1 관측 | 판정 |
|---|---|---|
| raw 상태·품질 | `completed`, `qualityRejected=true`, `FORMAT_MISMATCH` | executor 종료일 뿐 품질 PASS 아님 |
| 대상 | 응답이 `team_tech-port-05-upgrade-regression`을 설명 | Team 06 요청과 불일치 |
| 기존 수정 확인 | commit `e6efcf1`이나 현재 scorer 코드 언급 없음 | “먼저 확인” 조건 불이행 |
| patch·rollback | 경로·diff·commit·rollback 없음 | bounded fix 증거 없음 |
| 검증 | 자동 `npm run build` exit 0만 존재 | 요구한 별도 `npx tsc --noEmit`·관련 vitest 영수증 없음 |
| 증거 | `evidence_json=NULL` | 완료 주장 근거 없음 |
| retry | `retry_counts=1`, child `task_BL9Sa_fh5FHMFN7y` queued | 교정 결과 미확정 |

응답은 실제 수정 보고가 아니라 무관한 함수 설명이므로 산출물 등급은 T4다.
공식 false-report row가 없어 “악의적 허위”로 확정하지 않지만, 이 응답으로
소스 패치가 완료됐다고 채택할 수 없다.

### 기존 scorer 수정 `e6efcf1` — 별도 T1, 이번 자가개선에 귀속 금지

commit `e6efcf1336802c80d3cd02435bf980cc254b8627`은
2026-07-24 11:20:27 KST에 생성됐고, 이번 자가개선 task는
11:31:29~11:31:50 KST에 실행됐다. commit/file 내용은 orphan 제외와
회귀 테스트가 실제 존재한다는 T1 증거지만, 시간상 이미 존재한 수정이며 이번
자가개선 응답도 이를 언급하지 않았다.

현재 worktree에는 이 조사 시작 전부터 `src/core/team-scorer.ts`와 테스트의
미커밋 수정이 별도로 존재했다. 이 문서는 소유권이 확인되지 않은 해당 변경을
수정·stage·commit하거나 이번 자가개선 task에 귀속하지 않는다.

## T1 재현 쿼리

```sql
SELECT id, assigned_to, status, created_at, completed_at, error,
       json_extract(metadata_json,'$.workReportId') AS work_report_id,
       json_extract(metadata_json,'$.qualityRejected') AS quality_rejected,
       json_extract(metadata_json,'$.qualityHeuristics') AS heuristics,
       heartbeat_seq, evidence_json
FROM tasks
WHERE team_id='team_tech-port-06-improvement-debate'
  AND created_at >= datetime('2026-07-24 02:30:00','-48 hours')
  AND created_at <= '2026-07-24 02:30:00'
ORDER BY created_at;
```

```sql
SELECT p.id AS parent_id, c.id AS child_id, c.status, c.error,
       json_extract(c.metadata_json,'$.qualityHeuristics') AS child_heuristics,
       r.count AS retry_count
FROM tasks p
JOIN tasks c ON c.parent_task_id=p.id
LEFT JOIN retry_counts r ON r.task_id=p.id
WHERE p.id IN (
  'task_9NxxNDRueeHKplTB',
  'task_Pe00dCrVyKbbWFcM',
  'task_zpPvDFRqCqWu4NUE'
)
ORDER BY p.created_at, c.created_at;
```

## 외부 상태 변화

HR 지시 스냅샷 뒤 2026-07-24 02:40:00 UTC에 scheduler가
`tle_z-rD5KKyA6weSFfe` retirement 이벤트를 기록했고 현재 DB의 team
`is_active=0`, lifecycle profile `status=retired`다. 이는 이 조사에서 수행한
변경이 아니며, HR 전권 영역이므로 되돌리거나 수정하지 않았다. 지시 시점
score 64.5와 이후 score 64.4를 섞지 않고 본문은 02:30 스냅샷으로 고정했다.

## 검증 영수증

- [변경] `src/server/task-intake.ts` — Team 06 직접 작업과 명시적
  `diagnosticTargetTeamId`에만 `[06 Improvement Debate 응답 계약]`을
  멱등 주입.
- [변경] `src/server/task-intake.test.ts` — 직접 팀·진단 대상·retry 중복
  방지·다른 팀 무변경 회귀 케이스 추가.
- [변경] `docs/self-improve/tech-port-06-duplicate-error-2026-07-24.md` —
  실제 task/retry/audit/Git 근거와 적용·검증 영수증을 기록.
- [검증방법] SQLite 재현 쿼리, 관련 Vitest, `npx tsc --noEmit`,
  `npm run build`, diff whitespace 검사.
- [등급] T1 — SQLite 원본 행, Git commit/file 내용, 실제 명령 출력.
- [Gap] 국소 코드·테스트·빌드는 검증했다. NCO API가 꺼져 있어 수정
  prompt를 실제 Team 06 task로 접수한 뒤 모델 응답이 prefix 계약을
  준수하는 운영 E2E는 검증하지 못했다.
- [미검증항목] 개선 후 새 48시간 score/completion, idempotency 적용 이후의
  고유 workReport별 lease 분포, provider CLI 내부의 개별 도구 호출
  인자·결과, 운영 배포·재시작 후의 E2E 결과.

### 검증 로그

```text
$ npx vitest run src/core/team-scorer.test.ts src/server/task-intake.test.ts tests/response-quality.test.ts
Test Files  3 passed (3)
Tests       28 passed (28)
Duration    1.23s
exit code   0
```

```text
$ npx tsc --noEmit
(출력 없음)
exit code 0
```

```text
$ npm run build
> neural-cli-orchestrator@1.0.0 build
> tsc
exit code 0
```

```text
$ task_doc_check=$(git diff --no-index --check /dev/null docs/self-improve/tech-port-06-duplicate-error-2026-07-24.md 2>&1 || true)
$ test -z "$task_doc_check"
(출력 없음)
exit code 0
```

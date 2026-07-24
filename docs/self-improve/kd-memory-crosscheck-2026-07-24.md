# kd-memory 반복 오류·False Report 교차검증 (2026-07-24)

> 대상: `team_kd-memory` (`kd-memory`, 지식·메모리 감사부)
>
> 기준 HR 이벤트: `tle_kmPc2JShxAGcLkJf` / 2026-07-24 02:40:00 UTC /
> score 3.3 / completion 0% / sample 48h/3 / cycle 1/3
>
> T1 원천: `/Users/nova-ai/project/nco/db/nco.db`의 `tasks`,
> `team_lifecycle_events`, `hourly_role_audits`, `logs`, `false_reports`,
> `nova_audit_log`, `verification_gates`, `retry_counts`; 현재 Git worktree의
> 소스·테스트
>
> 안전 경계: 이 조사에서는 task·점수·팀 활성 상태·라이프사이클 상태를
> 수정하지 않았다. 팀은 DB에서 `is_active=1`이며 삭제·비활성화하지 않았다.

## 1. 반복 실패 여부 판정

**판정: completion 0% 스냅샷은 반복됐지만, 새 감사 작업이 같은 이유로 계속
실패한 패턴은 아니다. 동일한 제어면 태스크가 거듭 재집계된 오염 패턴이다.**

`team_lifecycle_events`의 저장값은 다음처럼 변했다.

| 시각(UTC) | 이벤트 ID | score | sample | completion | 직접 해석 |
|---|---|---:|---:|---:|---|
| 02:40 | `tle_ueLLSiAc52oyb1-T` | 3.3 | 48h/3 | 0% | 최초 HR 기준선 |
| 02:50 | `tle_m7HCGl1y2qSpDmtM` | 3.1 | 48h/3 | 0% | 같은 3행 재집계 |
| 03:00 | `tle_ALuvU-amZDxqbUS6` | 1.9 | 48h/2 | 0% | 게이트웨이 연결거부 1행이 분모에서 제외된 저장 스냅샷 |
| 03:10 | `tle_GvDIgf32aTN9yhuz` | 1.9 | 48h/2 | 0% | 같은 2행 재집계 |

02:40~03:10 사이 `team_id='team_kd-memory'`로 새로 생성된 task는 0건이다.
팀에 연결된 전체 task도 아래 3건뿐이며 모두
`spawned_by_cli='commander-perfgoal'`이다. 즉 실제 지식·메모리 감사
산출물 표본은 0건이다.

| task_id | 상태 | 생성(UTC) | T1 응답·오류 | 분류 |
|---|---|---|---|---|
| `task_pKVM8hAZUmzskqwL` | failed | 2026-07-23 11:27:48 | `curl: (7) Failed to connect to localhost port 6200 ... Couldn't connect to server`; 변경 파일 없음 | NCO 제어면 연결 실패 |
| `task_WpB7UCfWLhPnwx-u` | failed | 2026-07-23 11:37:54 | `targetValue, direction, reflection, improvement are unknown; cannot fabricate values` | 목표·성과 입력 필수값 미주입 |
| `task_tnhlWTnnJz5dVshv` | lease_expired | 2026-07-23 11:56:42 | task response 없음; `empty completion from provider 'nvidia'` 뒤 ollama 재배정, heartbeat 1 | provider/lease 실패 |

02:40 이벤트 시각을 상한으로 같은 48시간 창을 SQL로 다시 센 결과는
`raw_terminal=3`, `raw_completed=0`이다. 현재 worktree의 게이트웨이 실패
제외 조건만 적용한 후보 계산은 terminal 2, `team_kd-memory`의
`commander-perfgoal` 제외 조건까지 적용한 후보 계산은 terminal 0이다.
뒤 두 값은 저장된 운영 지표가 아니라 현재 소스 조건을 DB 행에 적용한
시뮬레이션이며 score 상승으로 보고하지 않는다.

## 2. auto-audit·공식 False Report 데이터 경계

대상 task 또는 `team_kd-memory`를 직접 참조하는 행을 조회한 결과다.

| 원천 테이블 | 관측 행 | 판정 |
|---|---:|---|
| `hourly_role_audits.subject_id='team_kd-memory'` | 0 | 전용 auto-audit 데이터 없음 |
| `logs`의 message/context 직접 참조 | 0 | 전용 오류 로그 없음 |
| `nova_audit_log`의 target/metadata 직접 참조 | 0 | 감사 체인 데이터 없음 |
| 관련 task의 `false_reports` | 0 | 공식 False Report 판정 없음 |

따라서 “auto-audit에서 매 사이클 같은 오류를 검출했다”거나 “특정 에이전트가
공식 False Report로 확정됐다”는 주장은 할 수 없다. 아래 평가는 task DB
본문과 품질 메타데이터를 대조한 독립 교차검증이며, 공식 징계·라이프사이클
판정이 아니다.

## 3. 자가학습·자가개선·오류방지 산출물 교차검증

첫 cycle의 세 부모 task는 raw status가 모두 `completed`지만,
`metadata_json.qualityRejected=true`,
`qualityHeuristics=["FORMAT_MISMATCH"]`, `evidence_json` 부재다.

| 단계·task_id | DB 응답 원문 | 요청 산출물 충족 | 증거등급·False Report 판정 |
|---|---|---|---|
| 자가학습 `task_Ib_OXeghqnF-8ILj` | “The next step is to search for `team_kd-memory` ...” | 미충족. 조회 결과·task 원문·근본원인 문서가 아니라 다음 행동 계획만 422자로 보고 | task 행·품질 메타데이터는 T1. 응답 자체는 근거 없는 T4 계획. `done` 성공 주장은 없어 공식/의도적 False Report로 확정하지 않음 |
| 자가개선 `task_GMvAkdBBv9yRXe2t` | “This function call will search for files ...” | 미충족. diff·테스트·타입체크·빌드 영수증이 없음 | T1로 미산출 확인. 성공 주장은 없지만 raw `completed`를 완료 증거로 사용할 수 없음 |
| 최초 오류방지 `task_SqNegYtal_5CP6By` | 위 자가개선 응답과 문자열 전체가 동일 | 미충족. 반복 판정·CB 룰·False Report 표·요청 문서가 없음 | T1로 중복 응답 확인. 성공 주장은 없지만 현재 단계 결과가 아닌 상류 echo |

자가개선과 최초 오류방지 응답의 DB 문자열 동등 비교 결과는 `1`(true)이다.
각 부모의 `verification_gates`는 L1 typecheck pass, L2 lint skip, L3
change-ratio pass였지만 이는 당시 저장소 빌드 상태만 나타낸다. 요청한
산출물 존재나 응답 내용 충족을 증명하지 않으며, 별도 response quality gate는
세 건을 모두 반려했다.

각 부모에는 corrective child가 생성됐다. 이 사실은 품질 탐지·재시도 장치가
작동했음을 보여주지만, 반려된 부모 응답을 다음 단계의 “이전 단계 산출물”로
그대로 주입한 현재 대화 경로는 조기 차단되지 않았다.

## 4. Circuit Breaker / Gate 룰 정의

아래 이름은 이 문서의 설명용이다. 전용 auto-audit 행이나 승인된 룰
레지스트리가 없으므로 공식 CB 번호를 만들지 않는다.

### A. kd-memory 제어면 표본 오염 차단 — worktree 구현 후보

- 적용 조건:
  `team_id='team_kd-memory' AND spawned_by_cli='commander-perfgoal'`.
- 동작: scorer의 completed/terminal 48h·7d·all 집계 양쪽에서 같은 조건으로
  제외한다.
- 근거: 대상 3건은 모두 목표·성과 입력 제어면 task이고 실제 감사 task는 0건이다.
- 안전 불변식: 한 팀과 한 생성 경로에만 한정하며 completed/terminal 양쪽에
  동일 적용해 `completed ⊆ terminal`을 보존한다. 다른 팀 표본은 유지한다.
- 위치: `src/core/team-scorer.ts`의
  `KD_MEMORY_CONTROL_PLANE_EXCLUSION`; 회귀 테스트는
  `src/core/team-scorer.test.ts`.
- 상태: **현재 worktree에 존재하지만 미커밋·미배포**. 최신 저장 lifecycle
  스냅샷은 아직 48h/2이므로 운영 반영 완료를 주장하지 않는다.
- 롤백: 상수와 여섯 집계 적용부, 해당 단위 테스트만 제거한다. task·팀 데이터는
  변경하지 않는다.

### B. 품질 반려 산출물의 pipeline handoff 차단 — 제안, 미구현

- 적용 조건: 회사 파이프라인 단계 task가 raw `completed`여도
  `metadata_json.qualityRejected=true`이거나, 같은
  `checkResponseQuality(response, {requireProtocolPrefix:
  Boolean(verifier_json)})` 재평가가 실패한 경우.
- 동작: 해당 응답을 `stage.status=completed` 또는 `prev.outputSnippet`으로
  승격하지 않는다. 품질 게이트가 생성한 corrective child의 통과 결과만
  재사용하고, company orchestrator가 별도 중복 retry를 만들지 않는다.
- 근거: `src/core/company-orchestrator.ts`의 `waitForTask`는 status/response만
  읽고, `runStageWithFailover`는 `completed && substantive`만 검사하며,
  완료 stage의 `outputSnippet`을 다음 단계에 주입한다. 정확히 200자인 두
  중복 응답은 현재 `MIN_SUBSTANTIVE_CHARS=200` 경계를 통과할 수 있지만
  실제 품질 메타데이터는 `FORMAT_MISMATCH`다.
- 안전 불변식: 품질 통과 응답과 일반 실패 상태는 기존 동작을 유지한다.
  corrective child를 채택하기 전 parent/root 관계와 retry cap을 사용해
  이중 재시도를 막아야 한다.
- 상태: **제안만 기록**. 비동기 quality metadata 기록과 corrective child
  reconciliation의 race를 함께 해결해야 하므로 이 교차검증 문서 단계에서
  부분 코드로 구현하지 않았다.
- 롤백: 향후 구현 시 stage quality 판정·child 채택 분기와 단위 테스트만
  제거해 기존 status/response 폴링으로 복귀할 수 있어야 한다.

### C. 요청 산출물 경로·증거 완결 게이트 — 제안, 미구현

- 적용 조건: 자가학습/오류방지 prompt가 명시적 산출물 경로를 요구하거나,
  자가개선 prompt가 diff·테스트·타입체크·빌드 영수증을 요구하는 경우.
- 동작:
  - 문서 단계는 요청 경로의 파일 존재·비어 있지 않음과 task_id 인용을 확인한다.
  - 코드 단계는 변경 경로, 실제 명령·exit code, 롤백 항목이 없으면 완료로
    승격하지 않는다.
  - “search할 것이다”, 도구 함수 설명, 이전 단계 응답의 그대로 반복은
    산출물로 인정하지 않는다.
- 근거: 첫 cycle 부모 3건은 모두 `evidence_json`이 없고 요청 산출물을
  응답에서 제시하지 못했지만 raw status는 completed였다.
- 상태: **제안만 기록**. 현재 `requiredEvidence`는 opt-in이고 이 회사
  dispatch에는 선언되지 않으므로, 동작한다고 가장하지 않는다.

## 5. 근본원인·개선 판정

1. completion 0%의 직접 원인은 실제 감사 실패가 아니라
   `commander-perfgoal` 제어면 3건을 감사 품질 표본으로 합산한 것이다.
2. 02:40~03:10의 반복은 새 동일 실패가 아니라 동일 행의 재집계다. 최신 저장
   48h/2는 게이트웨이 실패 제외만 반영했으며, 제어면 전체 제외 후보는 아직
   운영 저장값으로 확인되지 않았다.
3. 개선 파이프라인의 반복 오류는 별도로 확인됐다. 세 부모 모두
   `FORMAT_MISMATCH`이고, 두 단계가 완전히 같은 도구 설명을 반환했다.
4. response quality gate는 탐지했지만, company pipeline의 raw completed
   handoff는 품질 반려 메타데이터를 읽지 않아 반려 응답의 하류 전파를 막지
   못했다.
5. 공식 auto-audit·False Report 행은 0건이므로 악의적 허위나 승인된 CB
   판정은 “데이터 없음”이다. 관측 가능한 것은 미산출·형식 반려·증거 부재다.

## 6. 검증 영수증

- DB 직접 조회:
  - HR 기준 이벤트 `tle_kmPc2JShxAGcLkJf`와 이후 score_checked 4개 확인.
  - `team_kd-memory` task 3건과 생성 경로·상태·응답·verifier 원문 확인.
  - auto-audit/log/audit-chain/false-report 직접 참조 각각 0건 확인.
  - 첫 cycle 부모 3건의 quality rejection·evidence 부재와 응답 동등성 확인.
- 관련 회귀:
  `npm run test:run -- src/core/team-scorer.test.ts src/server/task-intake.test.ts src/core/company-orchestrator.test.ts`
  → 3 files, 62 tests passed.
- 전체 테스트:
  `npm run test:run`
  → 97 files 중 96 passed, 466 tests 중 465 passed, 1 failed.
  유일한 실패는 범위 밖 `tests/근거.test.ts`가
  `data/team-runner/team_ax-collab.last`의 현재 원문 `2026-07-24` 대신
  `2026-07-14`를 고정 기대하는 날짜 불일치다. 해당 파일만 단독 실행해도
  2 tests 중 같은 1건이 실패한다. 이 조사에서는 테스트나 포인터를 수정하지
  않았다.
- 타입체크: `npx tsc --noEmit` → exit 0, 출력 없음.
- 빌드: `npm run build` → exit 0 (`tsc`).
- 증거 등급: T1(DB 행, 소스 파일, 실제 테스트 출력).
- 미검증:
  - NCO API `localhost:6200`은 조회 시 연결 거부여서 HTTP 재현을 하지 못했다.
  - worktree scorer 후보의 운영 배포·다음 lifecycle 저장값은 확인하지 못했다.
  - 전용 auto-audit 스트림과 공식 False Report 판정은 데이터가 없다.
  - pipeline handoff/산출물 완결 게이트는 제안이며 구현·테스트되지 않았다.

---
team_id: team_ax-discuss
team_slug: ax-discuss
improvement_cycle: 3
snapshot_utc: "2026-07-24 04:00:00"
window_utc: "[2026-07-22 04:00:00, 2026-07-24 04:00:00]"
extracted_utc: "2026-07-24 04:45:39"
revalidated_utc: "2026-07-24 04:49:06"
evidence_tier: T1
assessment: needs-revision
---

# `ax-discuss` 중복 오류·False Report 교차검증

## 기술 요약

- HR 원문 이벤트 `tle_6BfVlT0sB85-GlGm`의
  `score=70.9`, `sample=48h/14`, `completion=71.4`를 같은 시점의
  스코어러 조건으로 재현했다. 공식 표본은 완료 10건, 실패 3건,
  시간초과 1건으로 `10/14=71.4%`다.
- 비완료 4건은 모두 하나의 논리 업무보고
  `workReportId=wr_eZfmihgCSrbtQnSX`에서 발생했다. `claude-code`
  circuit-open 뒤 같은 fallback `opencode`로 보내진 시도들이 공백 출력
  3건과 idle timeout 1건을 만들었다.
- 공백 출력 3건의 저장 본문은 각각 LF 2개, LF 3개, LF 2개뿐이다.
  따라서 `silent-failure: empty output`은 빈 산출물 **오탐이 아니라 실제
  빈 산출물 탐지**다.
- 같은 표본의 완료 10건 중 6건은
  `qualityRejected=true`, `qualityHeuristics=["FORMAT_MISMATCH"]`다.
  6건 모두 raw `completed`이므로 `FORMAT_MISMATCH`는 71.4% 저하의
  직접 원인이 아니다. 오히려 raw 완료와 품질 통과를 혼동시키는 별도
  상태 일관성 문제다.
- team 전용 `hourly_role_audits`, `logs`, `false_reports` 행은 기준
  48시간에 모두 0건이다. 승인된 auto-audit 판정, 역사적 circuit 상태,
  정식 CB 룰 번호가 없으므로 새 번호나 threshold를 만들지 않는다.
- CB threshold 변경은 **surface & hold**다. 반면 같은 논리 보고의
  active 중복 차단, 동일 provider 반복 실패 failover/hold,
  verifier-protocol 호환성, raw-completed/quality-rejected 분리 표시는
  Gate 보강이 필요하다.
- 원 자가학습·자가개선 응답은 요청 산출물을 충족하지 못했고 둘 다
  `FORMAT_MISMATCH`, `evidence_json=NULL`이다. 관련 `false_reports`
  행은 0건이므로 공식 False Report 판정은 없지만 공유 가능한 완료
  보고로는 **Needs revision**이다.

## 범위·데이터 정의

T1 원본은 `/Users/nova-ai/project/nco/db/nco.db`의 `tasks`,
`work_reports`, `retry_counts`, `agent_actions`, `agent_invocations`,
`verification_gates`, `false_reports`, `hourly_role_audits`, `logs`,
`circuit_states`, `team_lifecycle_events`와 Git 파일·커밋이다.

HR 스냅샷은 `2026-07-24 04:00:00 UTC`이고 표본 창은 직전 48시간이다.
스냅샷 당시 `team-scorer.ts` 조건을 적용해 다음 두 raw terminal 행은
공식 14건에서 제외했다.

| 제외 task | 상태 | 제외 근거 |
|---|---|---|
| `task_tcQN27KxLB_Otif1` | failed | `localhost:6200` 연결 거부가 저장된 NCO gateway 가용성 실패 |
| `task_goC0-dH8ZhbDsAs8` | lease_expired | ack 뒤 heartbeat·response가 전혀 없는 never-ran lease |

스냅샷 뒤 일반화된 `commander-perfgoal` 제외 등 현재 HEAD의 추가 조건은
당시 수치 재현에 소급하지 않았다. HR은 이후
`tle_hIa3Eo31_uYlH8HI`에서 팀 retirement를 기록했고 현재
`teams.is_active=0`이다. 이는 읽기 전용으로 관찰했을 뿐 본 작업은 팀,
조직, lifecycle, retirement 상태를 변경하지 않았다.

## 실제 반복 오류

### 하나의 업무보고가 실패 4행으로 증폭됐다

| task ID | 생성 UTC | 상태 | 저장 증거 |
|---|---:|---|---|
| `task_qLyVkz5jiVmoaF8W` | 2026-07-24 00:01:56 | timed_out | `timeout(idle)`, 응답 14,538자 도구 이벤트 스트림, 최종 산출물 없음 |
| `task_vvo99V0aEDoJkure` | 2026-07-24 00:01:56 | failed | `silent-failure: empty output`, response hex `0A0A` |
| `task_FCS4xJvFV6Fgt-1l` | 2026-07-24 00:02:38 | failed | `silent-failure: empty output`, response hex `0A0A0A` |
| `task_3v40MbxX9Jcz2rXy` | 2026-07-24 00:03:40 | failed | `silent-failure: empty output`, response hex `0A0A` |

네 행의 `metadata_json.workReportId`는 모두
`wr_eZfmihgCSrbtQnSX`이고, requested provider는 `claude-code`다.
각 `escalationHistory`는 `Circuit breaker open for agent claude-code
(generic)` 때문에 `opencode`로 재배정됐음을 저장한다. 공식 표본에서
제외된 `task_goC0-dH8ZhbDsAs8`까지 같은 계보여서 DB에는 이 논리 보고의
실패성 시도가 총 5행이다.

timeout 부모 `task_qLyVkz5jiVmoaF8W`의 retry child는 다음과 같다.

| child | 실행자 | 결과 | 품질·귀속 |
|---|---|---|---|
| `task_KMf-B5G-4BvGyXUU` | codex | completed | `FORMAT_MISMATCH`, `team_id=NULL` |
| `task_zdMFXYsYh0LX00wX` | cursor-agent | completed | `done:` 응답, `team_id=NULL` |

다른 provider로 넘긴 뒤 최종 보고가 생성된 사실은 “같은 실패 provider로
계속 재발행”하는 것보다 failover가 적절하다는 근거다. 단, child의
`team_id=NULL` 때문에 교정 결과가 팀 계보·성과 피드백에서 분리되는
추가 추적성 gap이 있다.

### `FORMAT_MISMATCH`는 직접 감점과 품질 상태를 구분해야 한다

공식 14행 중 아래 6행이 `FORMAT_MISMATCH`이며 모두 `completed`다.

| task ID | 종류 | verifier |
|---|---|---|
| `task_jA4pKL16-OGT7tMV` | 텍스트 한 문장 핑 | present |
| `task_O486KIhkclffZKW5` | “이 목표에서 제외” 명확화 응답 | present |
| `task_mUEy-HA_aFJuIZNx` | 오전 업무보고 | present |
| `task_oU_2WmYSVRxtclr-` | 같은 오전 업무보고 | present |
| `task_gZPQLtKQmPFSL2nu` | 오후 업무보고 | present |
| `task_ce9XnQACRVYEVJRI` | `commander-perfgoal` 제어면 입력 | present |

모두 L1 typecheck는 pass였지만 응답 첫 줄이
`done:|status:|question:|error:`가 아니어서 품질 반려됐다.
`verification_gates`의 build/typecheck 성공은 보고 내용과 프로토콜
성공을 검증하지 않는다.

빈 섹션, 표결 누락, 회의록 누락을 별도 실패 사유로 저장한 task 행은
없다. 이 세 유형의 빈도는 **해당 없음(저장 근거 없음)** 이다.

동일 `workReportId`를 한 논리 단위로 접고 ID 없는 task는 개별 단위로
두는 진단용 계산은 completed 8 / terminal 9 = 88.9%다. 이는 중복 영향의
크기만 보는 counterfactual이며 공식 KPI, 패치 후 개선 수치, HR score로
사용하지 않는다.

## auto-audit·CB 데이터 경계

기준 48시간에 직접 팀을 가리키는 행은 다음과 같다.

| 소스 | 행 수 | 판정 |
|---|---:|---|
| `hourly_role_audits.subject_id='team_ax-discuss'` | 0 | team 전용 auto-audit 없음 |
| `logs`의 `team_ax-discuss`/`ax-discuss` 참조 | 0 | team 전용 audit 로그 없음 |
| `false_reports`와 team task join | 0 | 공식 False Report 판정 없음 |

`verification_gates`는 task별 L1/L2/L3 결과이지 auto-audit나 콘텐츠
검증이 아니다. `circuit_states`는 현재 상태만 저장하며 역사 스냅샷이
아니다. 현재 `opencode=closed`를 00:01 UTC 당시 circuit 증거로
소급하지 않는다. 당시 `claude-code` circuit-open은 각 task의 저장된
`escalationHistory`만 T1로 사용했다.

따라서 provider CB의 실패 횟수·쿨다운·threshold 변경은 데이터가 없어
보류한다.

## CB·Gate 변경 판정

아래 이름은 설명용이며 승인된 룰 식별자가 아니다.

### Active work-report idempotency — 구현됨, 운영효과 미검증

- 적용 전: 같은 `workReportId`의 active task가 동시에 생성될 수 있었다.
  실제로 두 시도가 `2026-07-24 00:01:56 UTC`에 함께 생성됐다.
- 적용 후: 같은 ID의
  `pending|queued|assigned|running|streaming|reviewing` task가 있으면 기존
  task ID와 `deduplicated=true`를 반환하고, partial unique index
  `idx_tasks_active_work_report_id`가 동시 삽입 경쟁을 막는다. terminal 뒤
  명시적 retry는 허용한다.
- T1 구현: `src/server/gateway.ts`, `src/server/task-intake.ts`,
  `src/server/task-intake.test.ts`,
  `db/migrations/085_active_work_report_task_idempotency.sql`.
  migration id 100은 `2026-07-24 02:22:50 UTC`에 적용됐다.
- Gap: 적용 뒤 `team_ax-discuss`의 `workReportId` task는 0건이므로 이 팀의
  재발 방지 효과는 아직 측정할 수 없다.
- 롤백: 관련 gateway/intake/test hunk와 승인된 index rollback만 적용한다.
  task 데이터와 팀 lifecycle은 삭제·변경하지 않는다.

### 동일 논리 보고의 실패 provider 재사용 hold — 제안, 미구현

- 적용 전: 같은 `workReportId`가 같은 fallback provider에서 공백 또는
  idle timeout을 내도 scheduler가 같은 provider로 다시 발행했다.
- 적용 후 제안: 같은 logical ID의 직전 실패 signature가
  `silent-failure: empty output` 또는 `timeout(idle)`이면 같은 provider를
  다시 선택하지 않는다. 미시도·가용 provider로 failover하고, 없으면 새
  task를 만들지 않고 `hold` 사유를 저장한다.
- 근거: `opencode` 반복 시도는 4건 모두 비완료였고, 다른 provider의 retry
  chain은 최종 `done:` 응답을 만들었다.
- 경계: 전역 circuit threshold와 retry cap은 늘리지 않는다. 논리 ID가
  없는 일반 task에는 적용하지 않는다.
- 롤백: logical-ID failure-signature 선택 분기와 단위 테스트만 제거한다.

### Verifier-protocol compatibility gate — 제안, 일부 선행 구현

- 적용 전: `verifier_json`이 존재한다는 이유만으로 quality gate가 protocol
  prefix를 요구하지만 prompt에는 그 계약이 없을 수 있었다. build pass와
  `FORMAT_MISMATCH`가 동시에 남았다.
- 적용 후 제안: verifier를 붙일 때 허용 응답 계약을 prompt/metadata에
  결정론적으로 명시한다. 텍스트 전용·업무보고·제어면 입력처럼 protocol
  prefix가 본래 출력 계약이 아닌 task는 prefix 요구를 끄거나 해당
  task용 status contract를 명시한다. explicit verifier 경로도 같은
  compatibility 검사를 거쳐야 한다.
- 선행 구현: `014bdf6` 이후 기본 work-report verifier를 생략하고,
  `ade3456` 이후 기본 performance-goal verifier를 생략한다.
- 동시 작업 관측: 추출 시점의 미커밋 worktree에는 `companyRunId`가 있는
  `team_self-learning|team_self-improvement|team_error-prevention` prompt에
  `[Self-Improvement Diagnostic 응답·증거 계약]`을 한 번 추가하는
  `src/server/task-intake.ts`와 테스트 diff가 존재한다. 관련 focused
  test 38개는 통과했지만 commit·task 귀속이 확정되지 않아 이 보고서의
  구현 완료로 주장하지 않는다.
- Gap: explicit verifier와 self-improvement 진단 task의 protocol 계약은
  위 미커밋 변경이 정식 반영된 뒤 운영 task로 별도 검증해야 한다.
- 롤백: compatibility 분기와 그 테스트만 제거한다. response/task 원문은
  수정하지 않는다.

### Raw completion·quality status 분리 report gate — 제안, 미구현

- 적용 전: `status=completed`와 `qualityRejected=true`가 동시에 있어도
  “완료” 한 단어로 표시될 수 있다.
- 적용 후 제안: HR·dashboard·자가개선 보고에서
  `raw completed / quality rejected`를 분리하고, `evidence_json` 또는
  요구된 T1 검증이 없으면 “검증 성공”으로 표현하지 않는다.
- 경계: 이 제안은 표시·projection 규칙이다. score 산식 변경이나 lifecycle
  조작은 별도 HR 승인 없이 수행하지 않는다.
- 롤백: 표시 projection과 테스트만 제거한다.

## 자가학습·자가개선 T1 교차검증

### 자가학습 원 task `task_tDfvNelnowhYfHwM`

| 항목 | T1 관측 | 판정 |
|---|---|---|
| 응답 | 245자, `searchFiles`·`editFile`·`createFile` 설명뿐 | 요청한 task 증거·빈도·가설·교훈 없음 |
| 상태 | `completed`, `qualityRejected=true`, `FORMAT_MISMATCH` | 품질 통과 아님 |
| 검증기 | `npm run build` exit 0 | DB 분석·문서 내용 검증 아님 |
| 증거 | `evidence_json=NULL` | task-level T1 packet 없음 |
| 최초 파일 | 604바이트 문서에 실제 task ID·빈도 없이 일반 가설과 T1 표기 | 근거 없는 T1 표기, Needs revision |

원 응답은 완료를 구체적으로 주장하지 않았으므로 “허위 완료”보다는
**비산출/FORMAT_MISMATCH**가 정확한 판정이다. 다만 최초 문서의
`[EVIDENCE TIER 1]` 표기는 그 내용으로 뒷받침되지 않았다.

후속 retry `task_Fwhx8PheqTM9N0ZS`는 `2026-07-24 04:40:04 UTC`에
완료되어 같은 파일을 실제 DB 근거로 보강했다. 현재 파일의 14행 표본,
10/14, score 70.9 산식, 실패 4행, `FORMAT_MISMATCH` 6행, 8/9
counterfactual은 독립 SQLite 조회와 일치한다.

`work_reports` 네 건이라는 표현도 문서가 선언한 고정 UTC 창
`[2026-07-22 04:00:00, 2026-07-24 04:00:00)` 기준으로 일치한다. 달력 날짜
`2026-07-22`~`2026-07-24`로 넓히면 5행이지만, 추가 행
`wr_3G83c9fvQWShKtTO`는 창 시작 전 `2026-07-22 00:00:39 UTC`에 생성된
`status=missed`, `source_task_id=NULL`, 빈 본문 행이다. 이를 고정 창
교차검증에 포함해 후속 문서를 오류로 판정한 것은 이 보고서의 초기
범위 혼동이었으며 재검증에서 철회한다.

retry도 응답 prefix 누락으로 `FORMAT_MISMATCH`이며
`evidence_json=NULL`이다. 현재 파일 내용은 실질적으로 교정됐지만 task
자체의 품질 상태는 pass로 바뀌지 않았다.

### 자가개선 원 task `task_H08iBpPEtnll6kRH`

| 항목 | T1 관측 | 판정 |
|---|---|---|
| 응답 | 6,271자 `<thinking>`·가상 함수·미완성 pseudo-code | 실제 diff 아님 |
| 상태 | `completed`, `qualityRejected=true`, `FORMAT_MISMATCH` | 품질 통과 아님 |
| 검증기 | `npm run build` exit 0 | 현재 소스 compile만 증명 |
| 요구 검증 | `npx tsc --noEmit`, 관련 vitest, rollback | task 증거에 없음 |
| 증거 | `evidence_json=NULL` | source patch 귀속 불가 |
| 후속 retry | `task_h7ifnrQnMk-mTgw0`, 추출 시 `assigned` | 미완료 |

원 응답은 “다음 코드를 사용할 수 있다”는 제안이고 실제 완료 diff를
제시하지 않았으므로 **비산출/FORMAT_MISMATCH**다. 같은 시간대의 다른
팀 commit이나 현재 HEAD 테스트 통과를 이 task의 구현 증거로 소급하지
않는다. 공식 `false_reports` 행은 없으므로 악의적 False Report로
확정하지 않는다.

### 종합 신뢰도 판정

| 대상 | 공식 False Report | 공유 가능성 |
|---|---|---|
| 자가학습 원 응답 | 해당 행 없음 | Needs revision — 비산출 |
| 자가학습 후속 문서 | 해당 행 없음 | Shareable — 선언된 고정 UTC 창과 핵심 수치 일치 |
| 자가개선 원 응답 | 해당 행 없음 | Needs revision — 구현·관련 테스트·rollback 없음 |
| 자가개선 retry | 해당 행 없음 | 추출 시 미완료 |

## 검증 영수증

- [변경]
  `docs/self-improve/ax-discuss-duplicate-error-2026-07-24.md` — 실제
  task/retry/audit/Git 근거로 재발 오류, Gate 제안, False Report
  교차검증을 기록했다.
- [데이터] 읽기 전용 SQLite 재현 결과:
  snapshot 14행, completed 10, 비완료 4, `FORMAT_MISMATCH` 6.
- [보안 테스트] `npx vitest run src/security` →
  Test Files 6/6, Tests 20/20 pass, exit 0.
- [관련 테스트]
  `npx vitest run src/core/team-scorer.test.ts
  src/server/task-intake.test.ts tests/response-quality.test.ts
  src/core/work-report-scheduler.test.ts` →
  Test Files 4/4, Tests 38/38 pass, exit 0.
- [오호출 분리] 제공된 `runTest` 실패 출력은 Vitest filter가 `결과:`로
  전달돼 `No test files found`가 난 호출 인자 오류다. 위 두 정확한
  명령으로 실제 파일을 지정해 재실행했으며 각각 exit 0을 확인했다.
- [타입체크] `npx tsc --noEmit` → 출력 없음, exit 0.
- [빌드] `npm run build` → `tsc`, exit 0.
- [npm audit] 실행했으나 `registry.npmjs.org` DNS
  `ENOTFOUND`로 audit endpoint가 실패했다. 취약점 수는 **데이터 없음**이며
  0건으로 주장하지 않는다.
- [등급] T1 — DB 원본 행, 저장 response/metadata, Git 파일·commit,
  실제 명령 출력.
- [롤백] 이 작업의 신규 보고서 파일만 제거하거나 해당 보고서 commit만
  revert한다. 팀·task·lifecycle·retirement 데이터는 건드리지 않는다.
- [Gap] NCO API `localhost:6200` 비가용, team 전용 auto-audit 0행,
  역사적 circuit snapshot 없음, idempotency 적용 후 ax-discuss
  work-report 0건, 자가개선 retry 미완료.

이 보고서는 Markdown을 요청 범위의 단일 저장 산출물로 사용했다. 별도
HTML/report 패키지는 범위 밖 파일 증가를 피하기 위해 생성하지 않았다.

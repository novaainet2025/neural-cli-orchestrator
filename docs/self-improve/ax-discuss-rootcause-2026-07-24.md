---
team_id: team_ax-discuss
team_slug: ax-discuss
improvement_cycle: 3
snapshot_utc: "2026-07-24 04:00:00"
window_utc: "[2026-07-22 04:00:00, 2026-07-24 04:00:00]"
score: 70.9
completion: 71.4
sample: 48h/14
evidence_tier: T1
---

# Discussion Lead (`ax-discuss`) 실패 패턴과 근본원인

## 결론

`71.4%`를 직접 만든 것은 `FORMAT_MISMATCH`가 아니라 **하나의 2026-07-24
오전 업무보고가 네 개의 실패 task 행으로 집계된 것**이다. 공식 48시간
표본은 완료 10건, 실패 3건, 시간초과 1건으로 `10/14=71.4%`다. 실패성
4건은 모두 `workReportId=wr_eZfmihgCSrbtQnSX`이며, 같은 논리 업무가
`opencode`에서 세 번 빈 출력으로 실패하고 한 번 유휴 시간초과됐다.

`FORMAT_MISMATCH`는 별개의 품질 상태 불일치다. 표본에서 6건이
`qualityRejected=true`, `qualityHeuristics=["FORMAT_MISMATCH"]`이지만 모두
`status=completed`이므로 공식 completion의 분자를 줄이지 않았다. 다만
텍스트 보고·핑·제어면 요청에 코드 빌드 검증기와 프로토콜 접두사 계약이
함께 붙고, 품질 반려 task도 완료로 남아 **완료와 검증 성공을 구분할 수
없는 상태**를 만든다.

따라서 “팀 설정이 나쁘다” 또는 “회의록이 비어서 네 건 실패했다”는 기존
노트의 가설은 DB 근거가 없다. 관측된 직접 원인은 task-row 단위 중복 집계와
프로바이더 실행 실패이며, `FORMAT_MISMATCH`는 완료율 원인이 아니라 별도의
보고 신뢰도 결함이다.

## 기준 스냅샷과 재현

HR 이벤트 `tle_6BfVlT0sB85-GlGm`은 `2026-07-24 04:00:00 UTC`에
`score=70.9`, `metadata_json={"sample":"48h","n":14,
"completion":71.4,...}`를 저장했다. 같은 점검 실행에서 가장 큰 표본은
`team_self-learning`의 52건(`2026-07-24 04:00:01 UTC`)이었다. 당시
`team-scorer.ts` 산식으로 재현하면 다음과 같다.

```text
completion = round1(10 / 14 * 100) = 71.4
volume     = 100 * log10(14) / log10(52) = 66.790548...
score      = round1(0.9 * 71.4 + 0.1 * 66.790548...) = 70.9
```

DB에는 시간창의 terminal 원시 행이 16건 있다. 당시 스코어러
(`aff5990` 시점)의 가드에 따라 다음 두 행은 공식 14건에서 제외됐다.

| 제외 task | 생성 UTC | 상태 | 제외 근거 |
|---|---:|---|---|
| `task_tcQN27KxLB_Otif1` | 2026-07-23 11:53:11 | failed | NCO `localhost:6200` 연결거부가 응답에 있고 error가 `unknown: failure pattern in output`; 인프라 제외 |
| `task_goC0-dH8ZhbDsAs8` | 2026-07-24 00:05:44 | lease_expired | ack는 있으나 heartbeat·response가 없음; never-ran lease 제외 |

스냅샷 뒤 `commander-perfgoal` 제외 조건이 팀 공통으로 확대되었고 DB에는
새 task도 추가됐다. 그러므로 현재 코드를 현재 시각으로 실행한 값은 이 HR
스냅샷의 재현값으로 사용하지 않았다.

## 공식 48시간 task 표본

아래 14행은 HR 점검 당시 스코어러의 포함 조건으로 다시 조회한 결과다.
시간은 모두 UTC다.

| task ID | 생성 시각 | 실행자 | 상태 | 논리 업무 / 품질 상태 |
|---|---:|---|---|---|
| `task_NNUUMOVbLRTc2_Lh` | 07-22 07:06:17 | cursor-agent | completed | `wr_Tjky8jeRZxTT2Yr-`; 프로토콜 접두사 있음 |
| `task_jA4pKL16-OGT7tMV` | 07-22 09:23:13 | agy | completed | 핑 검증; `FORMAT_MISMATCH`; 역할을 모른다고 응답 |
| `task_O486KIhkclffZKW5` | 07-22 12:26:52 | claude-code | completed | “이 목표에서 제외” 요청; `FORMAT_MISMATCH`; 명확화 질문 |
| `task_iLFhsAx1YYD9kH_8` | 07-22 15:10:40 | claude-code | completed | 팀 일일 산출물; 품질반려 표식 없음 |
| `task_mUEy-HA_aFJuIZNx` | 07-23 00:01:35 | claude-code | completed | `wr_XCUiFgjTeN-TiZWF`; `FORMAT_MISMATCH` |
| `task_oU_2WmYSVRxtclr-` | 07-23 00:01:37 | claude-code | completed | 같은 `wr_XCUiFgjTeN-TiZWF`; `FORMAT_MISMATCH` |
| `task_4101CDKT9fi_SHbR` | 07-23 05:01:54 | opencode | completed | `wr_irmW330C9uoePzq-`; 프로토콜 접두사 있음 |
| `task_gZPQLtKQmPFSL2nu` | 07-23 05:02:04 | opencode | completed | 같은 `wr_irmW330C9uoePzq-`; `FORMAT_MISMATCH` |
| `task_ce9XnQACRVYEVJRI` | 07-23 11:30:10 | nvidia | completed | `commander-perfgoal`; `FORMAT_MISMATCH`; 실제 호출 증거 없이 예시 HTTP 성공 본문을 출력 |
| `task_0xiZg4I-uRBqI2So` | 07-23 15:19:06 | opencode | completed | 팀 일일 산출물; 품질반려 표식 없음 |
| `task_qLyVkz5jiVmoaF8W` | 07-24 00:01:56 | opencode | timed_out | `wr_eZfmihgCSrbtQnSX`; `timeout(idle)`, 923초, 응답 14,538자 도구 이벤트 스트림 |
| `task_vvo99V0aEDoJkure` | 07-24 00:01:56 | opencode | failed | 같은 `wr_eZfmihgCSrbtQnSX`; `silent-failure: empty output`, 22초 |
| `task_FCS4xJvFV6Fgt-1l` | 07-24 00:02:38 | opencode | failed | 같은 `wr_eZfmihgCSrbtQnSX`; `silent-failure: empty output`, 21초 |
| `task_3v40MbxX9Jcz2rXy` | 07-24 00:03:40 | opencode | failed | 같은 `wr_eZfmihgCSrbtQnSX`; `silent-failure: empty output`, 94초 |

### 상태별 빈도

| 분류 | 행 수 | 표본 대비 | completion 영향 |
|---|---:|---:|---|
| completed | 10 | 71.4% | 분자·분모 포함 |
| failed: 빈 출력 | 3 | 21.4% | 분모만 포함 |
| timed_out: 유휴 | 1 | 7.1% | 분모만 포함 |
| `FORMAT_MISMATCH` 품질 반려 | 6 | 42.9% | 6건 모두 completed이므로 직접 감점 없음 |

완료 10건 중 품질 반려는 6건(60.0%)이다. 따라서 `completed`를
“검증된 성공”으로 읽으면 안 된다.

## 논리 업무 단위 교차검증

`work_reports`의 같은 기간에는 네 개의 논리 보고가 있다.

| work report | 상태 | 연결 task 패턴 |
|---|---|---|
| `wr_Tjky8jeRZxTT2Yr-` | submitted | 완료 1행 |
| `wr_XCUiFgjTeN-TiZWF` | submitted | 같은 보고를 완료 2행으로 기록 |
| `wr_irmW330C9uoePzq-` | submitted | 같은 보고를 완료 2행으로 기록 |
| `wr_eZfmihgCSrbtQnSX` | missed | 공식 표본 실패성 4행 + 공식 표본에서 제외된 never-ran lease 1행 |

즉 상태 실패 4건은 네 개의 독립적 회의/보고 실패가 아니라 하나의 미제출
보고 계보다. 참고용으로 동일 `workReportId`를 한 단위로 접고,
`workReportId`가 없는 task는 각 한 단위로 유지하면 8 completed / 9
terminal = 88.9%다. 이는 중복 영향의 크기를 보여주는 **진단용
counterfactual**일 뿐, 현재 공식 KPI나 패치 후 수치로 주장하지 않는다.

## `FORMAT_MISMATCH`와 콘텐츠 공백의 경계

DB에 저장된 품질 반려 사유는 `FORMAT_MISMATCH` 6건뿐이다. 빈 섹션,
표결 누락, 회의록 누락을 별도 실패 코드로 저장한 행은 0건이다.

소스의 `checkResponseQuality`는 `verifier_json`이 붙은 응답에
`done:`, `status:`, `question:`, `error:` 접두사가 없으면
`FORMAT_MISMATCH`를 기록한다. 실제로 여섯 반려 응답은 모두 접두사가
없었고, 세 업무보고 행은 `npm run build` verifier가 exit 0이어도
반려됐다. 반대로 verifier가 없는 두 team-runner 완료 응답은 접두사가
없어도 반려되지 않았다. 이는 보고 내용 자체보다 intake/verifier 계약에
따라 판정이 달라짐을 보여준다.

논리 work report 네 건 중 submitted 세 건은 본문이 비어 있지 않으며,
세 본문 모두 회의록 등 팀 고유 원천 근거가 미확인이라고 정직하게
표기했다. 나머지 `wr_eZfmihgCSrbtQnSX` 한 건만 `missed`이고 body가
비어 있다. 따라서 “회의록·표결을 지어내지 않은 것”을 실패로 재분류할
근거는 없다. 콘텐츠 원천 부재는 별도 데이터 가용성 문제로 surface &
hold해야 한다.

## 근본원인 가설

### H1 — task 행이 아니라 논리 업무 계보를 세어야 한다 (확인됨)

단일 work report가 네 개의 실패성 행으로 fan-out/retry 되었고, 이 네
행이 공식 표본의 모든 실패를 차지한다. 요청 제공자는 `claude-code`였지만
각 행의 `escalationHistory`는 `Circuit breaker open for agent
claude-code` 뒤 `opencode`로 재배정됐음을 기록한다. 같은 fallback에서
빈 출력과 유휴 시간초과가 반복됐는데 스코어러는 각 시도를 독립 실패로
합산했다. 이것이 completion 저하를 가장 직접적으로 설명한다.

### H2 — 이질적인 task와 품질 상태가 한 지표에 섞인다 (확인됨)

표본에는 실제 업무보고 외에 핑 측정, “목표에서 제외” 요청,
team-runner 산출, `commander-perfgoal` 제어면 task가 함께 들어 있다.
동시에 `qualityRejected=true`인 여섯 행도 `completed`로 계산된다.
따라서 현재 completion은 Discussion Lead의 회의 진행·합의·회의록 품질만
측정하지 않고, 스케줄러 재시도·측정 task·제어면 task·프로토콜 형식을
혼합한다. `FORMAT_MISMATCH`를 completion 저하의 원인으로 단정하는 것도,
raw completion을 검증 성공률로 읽는 것도 둘 다 잘못이다.

## Mem0 연동용 핵심 교훈

1. 팀 완료율은 동일 `workReportId`/원본 계보를 한 논리 단위로 집계하고,
   retry·fan-out 행 수를 팀 실패 횟수로 중복 계산하지 않는다.
2. `commander-perfgoal`, 측정 핑, company control 요청은 팀 charter
   산출물과 분리한다. `team_id`가 같다는 이유만으로 품질 표본에 섞지 않는다.
3. `status=completed`와 `qualityRejected=true`를 동시에 보존하되,
   “실행 완료”와 “검증 통과”를 별도 지표로 보고한다.
4. 텍스트 전용 보고에는 코드 diff/build 계약을 자동 부착하지 않거나,
   필요한 프로토콜 접두사를 intake에서 결정론적으로 명시한다.
5. 회의 입력·표결·회의록 원천이 없으면 `미확인`으로 남긴다. 점수 회복을
   위해 회의·합의·결정 수치를 생성하지 않는다.

## 범위와 보류

- 이 문서는 읽기 전용 DB 조회와 저장된 파일/소스 확인만 수행했다.
- 코드, 팀 활성 상태, lifecycle profile, task 상태, Mem0 DB는 변경하지 않았다.
- 스냅샷 뒤 HR이 기록한 lifecycle 이벤트는 분석 창 밖이며 본 작업이 수정하지
  않는다. 팀 복구·퇴출 판단은 HR 소유다.
- NCO API `localhost:6200`은 조회 시점에 연결되지 않아 `list_tasks`/
  `get_task` HTTP 호출 대신 동일 운영 DB의 `tasks`, `work_reports`,
  `team_lifecycle_events` 원본 행을 읽기 전용으로 조회했다.
- 패치 후 점수나 100% 회복을 주장하지 않는다. 이 단계의 결론은 surface &
  hold이며, 후속 수정은 논리 업무 단위 집계와 task 종류 분리를 각각
  회귀 테스트로 검증해야 한다.

## 검증 영수증

- [변경] `docs/self-improve/ax-discuss-rootcause-2026-07-24.md` — 근거 없는
  일반론을 실제 48시간 task/work-report/lifecycle 증거로 교체
- [T1] `team_lifecycle_events.id=tle_6BfVlT0sB85-GlGm`의 score·표본 메타데이터
- [T1] `tasks` 원본 16행을 당시 scorer 가드로 재분류해 공식 14행과 제외 2행 확인
- [T1] `work_reports` 네 행의 status·source_task_id·body 존재 여부 확인
- [T1] `src/core/team-scorer.ts`, 당시 `aff5990` 버전,
  `src/verification/response-quality.ts`의 집계·형식 판정 조건 확인
- [T1] `npx tsc --noEmit` → exit 0
- [T1] `npm run build` → `tsc`, exit 0
- [미검증] NCO API 응답 본문과 독립 모델 교차리뷰는 서비스 비가용으로 수행하지 못함

# research-strategy 중복 오류·False Report 교차검증

- 대상: `team_research-strategy` (`research-strategy`, 리서치 기획·전략팀)
- DB 스냅샷: `db/nco.db`, `2026-07-24 05:27:52 UTC`
- 48시간 경계: `2026-07-22 05:27:52 UTC`
- 코드 기준: 조사 시작 시 HEAD `aa30b09ac2d665070368780bbb194f635a85ea7f`
- 판정: **scorer 제외 확대 불요; 남은 FORMAT_MISMATCH 재유입 경로에는
  team-scoped intake 계약을 최소 추가**

## 결론

HR에 주어진 `completion=89.5%, sample=48h/19`는 DB와 재현된다. 같은
고정 스냅샷에서 현재 HEAD의 실제 스코어러를 실행하면
`completion=94.4%, n=18, score=91.3`이다. 차이는
`task_Q6BfbJPLINuXwfwz`가 동일 `workReportId`의 완료 형제를 가진 중복
실패로 현재 `WORK_REPORT_DUP_DELIVERED_EXCLUSION`에 의해 제외되기 때문이다.

단, 이 개선을 이전 자가개선팀 응답의 성과로 귀속하면 False Report다.
그 응답이 예고한 커밋 메시지와 일치하는 `e6716022`는
`db/hnsw-indices/claude-code.hnsw` 바이너리만 바꾸었고
`src/core/team-scorer.ts`, `src/server/task-intake.ts`, 테스트 및 이 문서에는
diff가 없다. 기존 문서도 실제 분석이 아닌 `The content of the file` 23바이트
한 줄이었다. 현재 94.4%를 만든 scorer 변경은 별도 기존 커밋
`aa30b09a`의 범용 work-report 중복 제외다.

현재 HEAD에서 점수에 남아 있는 유일한 실패
`task_ewJ3BdhLQz5XfOcR`는 연구질문 분해 작업이 빈 출력 뒤 failover되어
`cursor-agent` exit 130으로 끝난 실제 미완료다. orphan, 제어면 목표설정,
중복 업무보고, gateway 연결거부 또는 `FORMAT_MISMATCH`로 보정할 근거가
없으므로 제외하면 안 된다.

반면 FORMAT_MISMATCH 9건과 그 direct retry 20건은 completion을 직접
낮추지는 않아도 실재하는 재시도 루프다. 업무보고 부모 5건은 기존
`isWorkReportPrompt()` 가드가 막지만, company-orchestrator 부모 3건과
텍스트 전용 측정 부모 1건은 잔여 경로였다. 이 작업은 점수 제외를 넓히지
않고 `src/server/task-intake.ts`에서만 다음 두 경로를 막는다.

1. `team_research-strategy`의 company run에 응답 첫 줄
   `done:|status:|error:` 계약을 1회 주입한다.
2. 실측 문구 `도구 금지, 텍스트만`을 text-only로 인식해 잘못된 build
   verifier를 붙이지 않는다.

## 48시간 원시 행과 스코어 판정

원시 terminal은 완료 17, 실패 4, lease 만료 1로 총 22건이다.

| task_id | agent / spawner | DB 상태 | 교차 근거와 근본원인 | 현재 HEAD 판정 |
|---|---|---|---|---|
| `task_crsv74dfMGsXkCAc` | cursor-agent / company-orchestrator | failed | `orphaned: server restart (poison — requeued 2x)`, HB 28 | 기존 `INFRA_EXCLUSION`으로 제외 |
| `task_Q6BfbJPLINuXwfwz` | opencode→claude-code / work-report-scheduler | failed | 최종 응답 1바이트, `silent-failure: empty output`; 같은 `wr_FSe6RYlwWkSeQLJQ`의 `task_79SN_f3zq1jr9Zj7`가 337자 보고서와 build exit 0으로 완료 | 현재 `WORK_REPORT_DUP_DELIVERED_EXCLUSION`으로 제외 |
| `task_ewJ3BdhLQz5XfOcR` | claude-code→cursor-agent / company-orchestrator | failed | 최초 실행 출력 공백, failover 뒤 `cursor-agent: CLI failed exit=130 — Aborting operation...`; `workReportId`와 완료 형제 없음 | **포함: 실제 미완료** |
| `task_0QLIjwR4g23aumMG` | claude-code→opencode / work-report-scheduler | lease_expired | tasks 행은 ack 있음·HB NULL·response NULL이나, `agent_actions`에는 만료 뒤 `opencode task:completed` 출력이 있고 verification gate 3종도 pass. 같은 `wr_0ojN9fmWtxNCleqY`의 완료 형제 2건 존재 | lease 가드와 delivered-duplicate 가드 모두 제외. **never-ran으로 단정 금지: 늦은 완료 race** |
| `task_buPTxnSXh7QBGP3r` | agy / commander-perfgoal | failed | tasks 행은 재시작 orphan이나 `agent_actions`에는 HTTP 201 검증을 주장한 completed 이벤트가 있음. 팀 charter가 아닌 제어면 목표·성과 입력 | `INFRA_EXCLUSION` 및 `CONTROL_PLANE_PERFGOAL_EXCLUSION`으로 제외 |

완료 17건의 ID와 상태는 DB에서 전부 직접 확인했다. 이 중
`qualityRejected=true`, `qualityHeuristics=["FORMAT_MISMATCH"]`인 행은
9건이지만 모두 raw `status=completed`다. 따라서 FORMAT_MISMATCH 자체가
89.5%의 분자를 깎거나 분모를 늘린 것은 아니다.

## 수정 전·후 재측정

동일 DB 스냅샷과 동일 48시간 경계에서 단계별로 scorer 조건을 적용했다.

| 단계 | completed | terminal | completion | 해석 |
|---|---:|---:|---:|---|
| 원시 tasks 상태 | 17 | 22 | 77.3% | 제외 규칙 미적용 |
| HR 수치 재현 / `aa30b09a` 직전 규칙 | 17 | 19 | **89.5%** | orphan·perfgoal·HB NULL lease 제외 |
| 현재 HEAD | 17 | 18 | **94.4%** | 위 조건 + 완료된 report의 중복 실패 1건 제외 |

현재 소스를 직접 실행한 결과:

```json
{
  "teamId": "team_research-strategy",
  "score": 91.3,
  "grade": "A",
  "completion": 94.4,
  "n": 18,
  "sample": "48h"
}
```

이는 운영 재계산·저장 결과가 아니라 현재 DB를 인자로
`computeTeamScores()`를 직접 실행한 재현값이다.

## 반복 오류 교차검증

| 패턴 | 48h 실측 | completion 직접 영향 | 판정 |
|---|---:|---|---|
| completed + `FORMAT_MISMATCH` | 9 | 없음: 9건 모두 completed | 품질/재시도 문제는 실재하나 score 저하 원인은 아님 |
| 위 9건에서 생성된 direct retry | 20 | 없음: retry child의 `team_id`는 NULL | 완료 15, 실패 5(서킷 open 3, orphan 2)로 불필요한 부하는 실재 |
| `lease_expired` | 1 | 기존 규칙으로 제외 | tasks 단독 조회 시 never-ran 오판 위험; `agent_actions`와 교차 필요 |
| gateway connection refused / `ECONNREFUSED` / NCO 6200 연결 실패 | 0 | 없음 | 이 표본용 신규 gateway CB 규칙 불요 |
| orphan | 2 | 기존 규칙으로 제외 | 신규 규칙 불요 |
| `silent-failure: empty output` | 1 | 현재 완료 형제 근거로 제외 | 기존 delivered-duplicate 규칙으로 충분 |
| CLI exit 130 | 1 | 실패 1건으로 정상 포함 | 증거 없이 인프라 제외로 넓히면 실제 실패 은폐 |

FORMAT_MISMATCH 9건의 spawner 분포는 work-report-scheduler 5,
company-orchestrator 3, claude-2-measure2 1이다.

- 업무보고 5건 / direct retry 9건: 기존 `isWorkReportPrompt()`가 기본
  build verifier를 생략한다(`014bdf68`).
- company-orchestrator 3건 / direct retry 8건: 이번
  `[Research Strategy 응답 계약]`이 company run에만 prefix 계약을 넣는다.
- claude-2-measure2 1건 / direct retry 3건: 이번 `TEXT_ONLY_PATTERN`
  보강이 실측 문구 `도구 금지, 텍스트만`을 인식한다.

응답을 무조건 PASS시키거나 실패를 score에서 빼지 않는다. 완료면 `done:`,
부분 완료·차단이면 `status:`와 `[미검증]`, 실제 실패면 `error:`를 요구해
정직한 실패 보고는 유지한다. 계약 주입은 marker로 멱등이며 company run이
아닌 research-strategy 태스크와 다른 팀에는 적용하지 않는다.

롤백은 `RESEARCH_STRATEGY_*` 상수와 company-run 분기, 그리고
`TEXT_ONLY_PATTERN`의 `도구 금지, 텍스트만` 대안 및 대응 테스트만 제거하면
된다. DB migration이나 scorer 변경은 없다.

## 감사 로그와 False Report 경계

- `logs`: 48시간 내 `team_research-strategy` 또는 위 실패 task ID 매치 **0건**.
- `hourly_role_audits`: 대상 팀 매치 **0건**.
- `false_reports`: 대상 팀 48시간 행 **0건**.
- `verification_gates`: 대상 팀 48시간 **78행**. 이는 typecheck/lint/change
  ratio 검증이며 독립 auto-audit 또는 산출물 진실성 증거가 아니다.
- `agent_actions`: task 실행 이벤트와 늦은 완료를 교차할 수 있는 T1 행이
  존재한다. 특히 `task_0QL...` 때문에 tasks의 HB NULL만으로 never-ran을
  선언하면 안 된다.

따라서 존재하지 않는 auto-audit 로그나 CB 룰 번호는 기재하지 않는다.
이 문서의 `INFRA_EXCLUSION` 등은 소스 상수명이며 운영 감사 룰 번호가 아니다.

## 변경 필요성 판정

**scorer/CB 제외 diff는 0, intake Gate 계약만 국소 수정한다.**

1. FORMAT_MISMATCH는 완료 9건에만 있어 89.5%의 직접 원인이 아니다.
2. 업무보고 5건은 기존 intake 가드가 막지만, company run 3건과 텍스트
   측정 1건은 잔여 재유입 경로여서 이번 patch가 필요하다.
3. orphan, perfgoal, delivered duplicate, lease 표본은 기존 scorer 가드로
   이미 제외된다.
4. 유일한 포함 실패는 완료 근거가 없는 CLI exit 130이므로 scorer 제외
   룰을 추가하면 점수만 올리는 False Report가 된다.

현재 HEAD의 범용 `WORK_REPORT_FANOUT_ALL_FAILED_EXCLUSION`은 이 팀 표본에서
적용 행이 0이라 이 보고서로는 승인하거나 효과를 주장할 수 없다. 완료 형제도
없는 모든 실패 fanout을 전부 제외하는 별도 전역 의미론은 대상 팀 범위 밖이며
추가 회귀 표본이 필요하다. 본 작업에서는 건드리지 않는다.

## 검증 영수증

- [변경] `src/server/task-intake.ts` — research-strategy company run 전용
  응답·증거 계약과 실측 text-only 문구 인식 추가.
- [변경] `src/server/task-intake.test.ts` — 계약 멱등성·범위 가드·prefix
  PASS 및 text-only verifier 생략 회귀 테스트 추가.
- [변경] `docs/self-improve/research-strategy-rootcause-2026-07-24.md` —
  23바이트 placeholder를 실제 DB·코드 교차검증 보고서로 교체.
- [scorer/lifecycle 변경] 없음. 팀 삭제·비활성화·lifecycle 변경 없음.
- [DB 검증] raw 17/22, HR 규칙 17/19=89.5%, 현재 HEAD
  17/18=94.4%; 비완료 5개 task ID와 exclusion 사유 직접 조회.
- [소스 검증] `computeTeamScores()` 직접 실행 →
  `score=91.3`, `completion=94.4`, `n=18`, `sample=48h`.
- [intake 검증] 실측 형태 prompt에서 계약 marker 1개, verifier 유지,
  `done:` 응답 quality PASS; `도구 금지, 텍스트만` prompt는 verifier 없음.
- [커밋 검증] `e6716022`는 HNSW 바이너리 1개만 변경;
  관련 scorer/intake/test diff 없음.
- [테스트] `npx tsc --noEmit` → exit 0;
  `npx vitest run src/core/team-scorer.test.ts src/server/task-intake.test.ts`
  → 2 files, 23 tests pass.
- [등급] T1 — DB 원시 행, `agent_actions`, `verification_gates`, git diff,
  현재 scorer 실행값을 직접 확인.
- [Gap] 92% — 대상 팀의 completion 원인과 기존 가드는 재현했고, 남은
  FORMAT_MISMATCH intake 경로를 unit test로 차단했다. 독립 auto-audit
  로그는 데이터소스가 없고, 운영 스코어 저장/HR 재집계는 실행하지 않았다.
- [미검증항목]
  - 현재 91.3점/94.4%의 운영 스케줄러 재저장 여부.
  - 새 intake 계약을 통과한 실제 후속 provider 응답(회귀 테스트만 수행).
  - source 상수에 대응하는 별도 운영 CB 룰 번호(로그 근거 없음).
  - 대상 표본에서 발동하지 않은 전역 all-failed fanout 제외의 타 팀 영향.

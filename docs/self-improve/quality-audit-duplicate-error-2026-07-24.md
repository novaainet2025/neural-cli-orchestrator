# quality-audit cycle 2 — duplicate error / False Report cross-check

- 대상: `quality-audit` / `team_quality-audit`
- HR 입력값: score `81.9`, completion `85.7%`, sample `48h/7`
- 분석 기준시각: `2026-07-24 04:38:36 UTC`
  (`task_CCH7EPttHlt6WBu6.created_at`)
- 소스 오브 트루스: `db/nco.db`, 현재 소스·git 객체
- NCO HTTP API: `localhost:6200` 연결 거부. 이 문서는 DB read-only 조회를
  API 성공으로 표현하지 않는다.

## 결론

`85.7%`의 직접 원인은 품질 감사 charter 실패가 아니라 기존 scorer 표본에
`commander-perfgoal` 제어면 실패 1건이 남은 범위 오염이다. 고정 48시간 원표본은
9건(완료 6, 실패 3)이고, orphan 2건과 perfgoal 2건은 1건이 겹친다.
따라서 제외 대상의 합집합은 3건이며, 현재 HEAD 조건을 같은 고정창에 적용한 결과는
6/6이다. 이는 counterfactual 재계산이며 운영 score 회복 주장이 아니다.

cycle 2에서 새로 확인한 반복 실패는 scorer가 아니라 자가개선 회사 실행의
중복 retry 경로다. `corun_zqaJa4qCdycVWqW4`에서 서로 다른 세 단계가
`FORMAT_MISMATCH` 완료행 4건을 만들었고, gateway 품질 retry와 company
orchestrator failover가 각각 동일 실패를 재시도할 수 있었다. 마지막 pipeline
stage는 기존 코드에서 substantive 검사를 우회해 도구 호출 JSON이나 도구 설명을
완료 산출물로 받아들일 수 있었다.

패치는 회사 pipeline을 품질 retry의 단일 소유자로 표시하고, gateway의 중복
retry를 중단한다. 모든 company stage(마지막 단계 포함)에 동일한 품질 검사를
적용하며, 관측된 직렬화 도구 호출·도구 설명 에코만 추가 차단한다. 독립 태스크의
기존 retry cap과 일반 JSON 문서 출력 동작은 유지한다.

## quality-audit 고정창 원표본

| task_id | status | spawner | 분류 |
|---|---|---|---|
| `task_uuStvylGPSQN-6KG` | completed | work-report-scheduler | charter/report 완료 |
| `task_16HQgVNhF7mF545t` | completed | team-runner | charter 완료 |
| `task_x_y4k22B50uQPE9U` | completed | work-report-scheduler | charter/report 완료 |
| `task_yTdf6-mNBkFq3g1U` | completed | work-report-scheduler | charter/report 완료 |
| `task_SMVL4-GzMPj56Wtg` | failed | commander-perfgoal | 제어면 필수값 미주입 |
| `task_zhONDDhk-axRXUId` | failed | commander-perfgoal | orphan + perfgoal 겹침 |
| `task_Pv7u4ADyacqfxLtG` | completed | team-runner | 입력 부재를 정직하게 보고 |
| `task_quality_check` | failed | NULL | orphan |
| `task_1n2K1YvoVdWphPhq` | completed | work-report-scheduler | charter/report 완료 |

DB 집계:

| 항목 | 값 |
|---|---:|
| raw terminal | 9 |
| completed / failed | 6 / 3 |
| timed_out / lease_expired | 0 / 0 |
| orphan rows | 2 |
| commander-perfgoal rows | 2 |
| orphan ∩ perfgoal | 1 |
| 현재 HEAD 제외 합집합 | 3 |
| 현재 HEAD 고정창 재계산 | 6/6 = 100.0% |

이전 교차검증 응답 `task_LiFrBxza7oil25UO`는 orphan 2건과 perfgoal 2건을
나란히 제시했지만 겹침 1건을 명시하지 않았다. 두 버킷을 더해 4건으로 해석하면
원표본 9건과 모순된다. 이 문서는 배타적 합집합 3건으로 정정한다.

## auto-audit / False Report 경계

같은 고정창에서 직접 확인한 행 수:

| 소스 | 행 수 | 해석 |
|---|---:|---|
| `hourly_role_audits.subject_id IN ('team_quality-audit','quality-audit')` | 0 | team 전용 auto-audit 판정 없음 |
| `logs`의 quality-audit / FORMAT_MISMATCH 매치 | 0 | 저장된 운영 로그 증거 없음 |
| target 9개 task의 `verification_gates` | 42 | 빌드·lint·change-ratio 실행 기록 |
| target task와 join되는 `false_reports` | 0 | 공식 False Report 판정 없음 |
| `false_reports` 전체 | 0 | 현재 DB에 공식 판정 자체가 없음 |

따라서 “False Report가 없었다”는 전역 결론은 낼 수 없다. 정확한 결론은
“공식 `false_reports` 행이 0이라 등록된 판정은 없으며, task·git 교차검증으로
보고 불일치 후보를 별도 식별했다”이다.

`e671602`의 커밋 제목은 `Circuit Breaker/Gate rule update: block repeated
failures`지만 실제 diff는 `db/hnsw-indices/claude-code.hnsw` 바이너리 1개뿐이다.
source/test/gate diff는 0이다. 같은 시각 완료된 `task_LiFrBxza7oil25UO` 응답은
“코드 변경 없음”이라고 적었으므로 응답 본문은 정직하지만, 커밋 제목은 실제 diff와
불일치한다. 공식 False Report로 단정하지 않고 **commit-message evidence mismatch**
후보로 분류한다.

`2026-07-24 05:07:52 UTC` DB 조회에서 `team_quality-audit.is_active=0`도
관측됐다. 이는 분석 기준시각 뒤인 `04:50:00 UTC`에 HR lifecycle이 기록한
`tle_xLlYpj2-Im2WI2u5`(`event_type='retired'`, 사유: 3개 개선 사이클 뒤에도
90점 미회복)과 일치한다. 이번 작업은 teams/lifecycle 행을 읽기만 했고
활성·퇴직 상태를 변경하지 않았다.

## 반복 FORMAT_MISMATCH 근거

`companyRunId=corun_zqaJa4qCdycVWqW4`에서 품질 거부된 완료행:

| task_id | team stage | response 패턴 | 판정 |
|---|---|---|---|
| `task_LPSTllG0JK8a6kX4` | self-learning | `searchCode function is used...` | FORMAT_MISMATCH |
| `task_YQA3FZvyMYrhursd` | self-learning | 도구 사용 권고·설명 | FORMAT_MISMATCH |
| `task_aZKo35ZaKhvZDCSI` | self-improvement | 잘린 `{"name":"searchCode"...}` | FORMAT_MISMATCH |
| `task_b3pWpidgeh9UcMT7` | error-prevention | 잘린 `{"name":"searchCode"...}` | FORMAT_MISMATCH |

네 행 모두 `status='completed'`와
`metadata.qualityRejected=true / ["FORMAT_MISMATCH"]`가 함께 남았다.
각 행 뒤에 별도 retry child가 생성됐으며, company orchestrator도 stage
executor failover를 보유한다. 즉 한 품질 실패를 두 제어면이 소유할 수 있었다.

## bounded / reversible patch

1. `src/verification/response-quality.ts`
   - company-owned 검사에서만 `TOOL_CALL_ECHO`, `TOOL_DESCRIPTION`을 추가한다.
   - 정상 JSON 배열·객체와 일반 문서 설명은 opt-in 밖에서 기존처럼 처리한다.
2. `src/core/company-orchestrator.ts`
   - task의 verifier 유무를 읽어 protocol prefix 계약을 동일하게 적용한다.
   - 마지막 stage는 길이 예외만 유지하고 품질 검사는 우회하지 않는다.
   - dispatch metadata에 `qualityRetryOwner='company-orchestrator'`를 기록한다.
3. `src/server/gateway.ts`
   - 위 소유권과 유효한 `companyRunId`가 함께 있을 때 quality metadata는
     기록하되 별도 gateway retry를 생성하지 않는다.
   - 독립 태스크는 기존 gateway retry 경로를 그대로 사용한다.

롤백은 위 세 항목과 관련 테스트만 되돌리면 된다. DB schema, team scorer,
team lifecycle, team 활성 상태는 변경하지 않았다.

## 검증 영수증

- [변경] company pipeline retry 단일 소유권 + 최종 stage 품질 gate +
  tool-call/tool-description echo 차단
- [DB] 고정창 raw 9, completed 6, failed 3, orphan 2, perfgoal 2,
  overlap 1, 현재 HEAD 재계산 6/6
- [관련 테스트] `npx vitest run tests/response-quality.test.ts
  src/core/company-orchestrator.test.ts
  src/core/company-orchestrator.reliability.test.ts
  src/server/task-intake.test.ts` → 4 files, 84 tests passed
- [타입체크] `npx tsc --noEmit` → exit 0
- [빌드] `npm run build` → exit 0
- [실응답 replay] build된 `dist/core/company-orchestrator.js`에 위
  FORMAT_MISMATCH 4개 response를 입력 → 4개 모두 `false`; 정상 대조군
  `task_uuStvylGPSQN-6KG` → `true`
- [전체 테스트] `npx vitest run` → 96 files / 475 tests passed,
  1 file / 1 test failed. 실패는 범위 밖 고정 날짜 회귀
  `tests/근거.test.ts`(`2026-07-14` 기대, 실제 최신 포인터 `2026-07-24`)다.
  이번 변경의 관련 테스트 실패는 0이다.
- [등급] T1: DB 행, git object, 파일 내용, 실제 명령 출력을 직접 확인
- [미검증] NCO API가 꺼져 있어 새 ownership 경로의 live HTTP 실행과 운영 score
  재계산은 미검증이다. `tsx -e` replay는 sandbox IPC `EPERM`으로 실패해
  build된 Node 모듈 replay로 대체했다.

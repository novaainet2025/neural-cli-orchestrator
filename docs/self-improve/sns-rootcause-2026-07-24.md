# SNS 블로그 홍보팀 completion 근본원인 분석

- 대상: `team_sns` (`sns`, SNS 블로그 홍보팀)
- 지시 시점: `2026-07-24 05:00:00 UTC` (`2026-07-24 14:00:00 KST`)
- 고정 분석 창: `2026-07-22 05:00:00` 이상
  `2026-07-24 05:00:00 UTC` 이하
- 원천: `db/nco.db`의 `tasks`, `agent_actions`, `work_reports`,
  `verification_gates`, `hourly_role_audits`, `false_reports`, `logs`,
  `team_lifecycle_events`
- 코드 기준: 조사 시 HEAD
  `e67be49373e67f15fe5b1b0e25a3056edc8e4a0e`
- 판정: **팀 산출물 실패가 아니라 제출 완료된 동일 업무보고의 timeout
  재시도 행을 별도 실패로 센 집계 오탐**

## 결론

HR 지시의 `completion=90.9%, sample=48h/11`은 고정 창의 운영 DB에서
완료 10건, timeout 1건으로 정확히 재현된다. 유일한 비완료
`task_1buIQ4HMK2VqOq3T`는 heartbeat 81회 뒤 idle timeout된 실제 실행
행이므로 never-ran은 아니다. 그러나 같은 팀·같은 논리 업무보고
`wr_pW-n8916p5xH2fQZ`를 재시도한
`task_C-Vh4cAIgGrKNTd_`가 21회 heartbeat 뒤 634자 보고서를 완료했고,
`work_reports` 원장도 이 후속 task를 `source_task_id`로 하여
`status=submitted`를 기록했다.

따라서 task 행 단위로 두 행을 각각 실패·성공으로 센 10/11은 실제
업무 단위 completion을 과소평가한다. 제출된 `workReportId`의 비완료
형제만 terminal 분모에서 제외하면 동일 고정 창은 10/10=100.0%다.
완료 형제가 없는 단독 timeout은 제외하면 안 된다.

이 범용 가드는 조사 전에 이미 커밋 `aa30b09ac2d665070368780bbb194f635a85ea7f`의
`WORK_REPORT_DUP_DELIVERED_EXCLUSION`과 회귀 테스트로 HEAD에 들어와 있다.
`team_lifecycle_events`도 이후 `2026-07-24 05:40:02 UTC`에
`score_recovered`, `score=95.1`, `sample=48h`, `n=10`을 기록했다.
이 이벤트의 metadata에는 completion 값이 없으므로 95.1의 세부 산식은
여기서 새로 주장하지 않는다.

반면 커밋 제목만 SNS 개선이라고 적힌 `e4183b52`는
`src/core/team-scorer.ts`를 바꾸지 않았다. 해당 커밋을 이번 점수 회복의
근거로 귀속하면 False Report다. 이번 자가학습 단계는 이미 존재하는
범용 수정의 적용 여부를 재검증했으므로 scorer 코드를 추가 수정하지 않는다.

## 48시간 태스크 증거

latency는 `created_at`부터 `completed_at`(없으면 `updated_at`)까지의 초다.
모든 행은 `tasks.team_id='team_sns'`이고 terminal 상태만 표시한다.

| task_id | 최종 agent / spawner | 상태 | latency | HB | workReportId / 응답 길이 | 판정 |
|---|---|---:|---:|---:|---|---|
| `task_1buIQ4HMK2VqOq3T` | opencode / work-report-scheduler | timed_out | 1,237s | 81 | `wr_pW-n8916p5xH2fQZ` / 0 | 완료 형제가 있는 중복 실행 행; 팀 산출물 실패에서 제외 |
| `task_C-Vh4cAIgGrKNTd_` | cursor-agent / work-report-scheduler | completed | 262s | 21 | `wr_pW-n8916p5xH2fQZ` / 634 | 같은 보고서를 제출한 근거 task |
| `task_CoVKMrdChBB0KI8P` | codex / claude-2-measure | completed | 113s | 12 | 없음 / 109 | 완료 |
| `task_3rkeqA5j7vdVHLHD` | codex / claude-2-measure2 | completed | 164s | 17 | 없음 / 33 | 완료; FORMAT_MISMATCH 표시는 별도 Gate 문제 |
| `task_QG5UbfrV7jfVN5Rm` | claude-code / work-report-scheduler | completed | 77s | 7 | `wr_XmBn3UmDdh8rNX6Q` / 2,757 | 완료; FORMAT_MISMATCH 표시는 별도 Gate 문제 |
| `task_OW5peRFzCY7LxWxV` | opencode / work-report-scheduler | completed | 57s | 15 | `wr_W8m2uBaVoY-Iutqw` / 377 | 완료; FORMAT_MISMATCH 표시는 별도 Gate 문제 |
| `task_lvH7aGN8omKxM3YE` | hermes / team-sns-cron | completed | 48s | 6 | 없음 / 4,740 | 완료 |
| `task_ofHrHOT2xF9GRMqX` | hermes / team-sns-cron | completed | 46s | 7 | 없음 / 4,897 | 완료 |
| `task_Np6BuuoNaTiFlykA` | ollama / team-sns-cron | completed | 64s | 6 | 없음 / 3,795 | 완료; FORMAT_MISMATCH 표시는 별도 Gate 문제 |
| `task_-IHvZrcelr8-fVL4` | ollama / team-sns-cron | completed | 65s | 7 | 없음 / 3,099 | 완료; FORMAT_MISMATCH 표시는 별도 Gate 문제 |
| `task_hxfc9WNA1JaeSmLv` | opencode / work-report-scheduler | completed | 55s | 14 | `wr_7FLwHGRr89QdOt3_` / 137 | 완료 |

## 에이전트별 성공·실패 패턴

| 최종 agent | completed | timed_out | 평균 latency | HB 범위 | 해석 |
|---|---:|---:|---:|---:|---|
| claude-code | 1 | 0 | 77.0s | 7 | 완료 |
| codex | 2 | 0 | 138.5s | 12–17 | 완료 2건 |
| cursor-agent | 1 | 0 | 262.0s | 21 | timeout된 보고서의 후속 제출 완료 |
| hermes | 2 | 0 | 47.0s | 6–7 | 완료 2건 |
| ollama | 2 | 0 | 64.5s | 6–7 | 산출물 완료, 형식 Gate 재시도는 별도 문제 |
| opencode | 2 | 1 | 완료 평균 56.0s, timeout 1,237s | 14–81 | 유일 timeout은 후속 제출된 동일 report의 중복 행 |

`task_1bu...`의 `agent_actions`는 최초 claude-code가 1바이트 공백
출력으로 완료 이벤트를 낸 뒤 opencode로 failover되어 idle timeout된 순서를
기록한다. 후속 `task_C-V...`도 최초 claude-code 공백 출력 뒤
cursor-agent가 634자 `done:` 보고서를 반환했다. 이는 팀 콘텐츠 능력
부족보다 scheduler/provider failover가 같은 논리 보고서를 여러 task 행으로
남긴 패턴이다.

## 후보 근본원인 배제

고정 창 11건에 대한 직접 집계는 다음과 같다.

| 후보 | 실측 | 판정 |
|---|---:|---|
| `lease_expired` | 0 | 원인 아님 |
| ack NULL | 0 | 큐를 잡지 못한 태스크 없음 |
| heartbeat NULL | 0 | never-ran 없음 |
| 최대 ack 지연 | 4.0s | 이 표본에서 큐 기아 근거 없음 |
| `orphaned:%` | 0 | 원인 아님 |
| circuit breaker open | 0 | 원인 아님 |
| NCO `localhost:6200` 연결거부 | 0 | 원인 아님 |
| 완료 형제가 있는 동일 workReport timeout | 1 | **completion 저하의 직접 원인** |

## FORMAT_MISMATCH 교차검증

FORMAT_MISMATCH는 completion 90.9%의 직접 원인은 아니지만 실제 재시도
부하는 발생시켰다.

- 팀 표본의 completed 부모 10건 중 5건이
  `metadata.qualityRejected=true`,
  `qualityHeuristics=["FORMAT_MISMATCH"]`다.
- 이 5개 부모는 direct retry 자식 14건을 만들었다. 자식은 14건 모두
  completed이고 모두 `team_id IS NULL`이며, 12건은 다시
  FORMAT_MISMATCH로 표시됐다.
- 따라서 부모는 completed로 분자·분모에 남고 자식은 `team_sns` 집계에
  들어오지 않아 HR completion을 직접 낮추지 않았다.
- 원인은 산출물 부재가 아니라 verifier가 요구한 첫 줄
  `done:|status:|question:|error:` 계약과 실제 자유형 응답의 불일치다.
  예를 들어 `task_Np6...`, `task_-IH...`는 각각 3,795자와 3,099자의
  홍보 콘텐츠를 냈지만 영어 `Pinterest...`로 시작했다.
- work-report 부모 2건, `team-sns-cron` 부모 2건,
  텍스트 측정 부모 1건에서 각각 재현됐다. 기존
  `isWorkReportPrompt()` 가드는 신규 업무보고의 verifier 오부착을
  방지하지만, verifier가 필요한 cron 산출물은 프롬프트에 첫 줄 응답
  계약을 명시해야 재시도 루프를 막을 수 있다.

권고 Gate 계약은 실패를 PASS로 바꾸는 규칙이 아니다.

1. verifier가 있는 `team_sns` task는 완료 시 첫 줄 `done:`, 부분 완료나
   미검증 시 `status:`, 실제 실패 시 `error:`를 명시한다.
2. text-only 핑과 `[업무보고 작성]`은 verifier를 붙이지 않는다.
3. quality reject의 direct retry에는 원 task의 `team_id`를 점수 집계용으로
   복사하지 않는다. 현재처럼 NULL로 두되 운영 부하는 별도 계수한다.
4. `workReportId` 중복 제외는 같은 팀·같은 ID의 completed 형제가 있을
   때만 적용한다. 단독 실패는 계속 실패로 센다.

## 자동 감사·False Report 경계

고정 창에서 확인한 데이터 경계는 다음과 같다.

- `hourly_role_audits.subject_id IN ('team_sns','sns')`: 0행
- 대상 11개 task의 `false_reports`: 0행
- team/task ID가 일치하는 `logs`: 0행
- 대상 11개 task의 `verification_gates`: 42행

`verification_gates`는 typecheck/lint/change-ratio 결과이며 독립
auto-audit 또는 False Report 판정이 아니다. 실제로 timeout task에도
초기 provider의 L1 pass가 있고, 제출 완료 task에는 중간 L1 fail 뒤
최종 L1 pass가 함께 있다. 존재하지 않는 auto-audit 판정이나 CB 룰 번호는
기재하지 않는다.

## bounded·reversible 수정 상태

추가 scorer diff는 불필요하다. HEAD의 기존 범용 수정은 다음 경계를 가진다.

```diff
+ delivered_work_reports :=
+   DISTINCT completed (team_id, metadata.workReportId)
+
+ terminal에서만 제외:
+   status <> 'completed'
+   AND same team_id/workReportId가 delivered_work_reports에 존재
```

- bounded: 동일 팀·동일 `workReportId`의 완료 형제가 있는 비완료 행만 제외
- 안전 가드: 완료 행은 분자에서 제거하지 않고, 완료 형제 없는 단독 실패는 유지
- reversible: `WORK_REPORT_DUP_DELIVERED_EXCLUSION`과
  `DELIVERED_WORK_REPORTS_JOIN` 및 대응 테스트만 제거하면 이전 동작
- 기존 회귀 테스트: 완료 형제가 있는 실패 2건은 제외하고, 완료 형제가 없는
  단독 실패 1건은 유지

## Mem0·지식 베이스 연동 항목

다음 지식을 `codex` 장기 기억과 프로젝트 knowledge base의
`bug_pattern`으로 저장한다.

> `team_sns`의 2026-07-24 48h completion 90.9%(10/11)는
> `wr_pW-n8916p5xH2fQZ`의 timeout 행과 제출 완료 재시도 행을 각각 센
> row-level 오탐이다. 동일 team/workReportId의 completed 형제가 있을 때만
> 비완료 형제를 terminal에서 제외한다. FORMAT_MISMATCH 5개 completed
> 부모와 자식 14건은 재시도 부하 문제지만 team completion의 직접 원인은
> 아니다. 근거: `task_1buIQ4HMK2VqOq3T`,
> `task_C-Vh4cAIgGrKNTd_`, commit `aa30b09a`.

저장 결과:

- Mem0: `mem0-1784872498652-falybd`
  (`agent_id=codex`, `user_id=team_sns`, BM25/FTS 저장,
  `NCO_MEM0_NO_EMBED=1`이라 embedding은 없음)
- knowledge base: `kb-sns-rootcause-20260724`
  (`category=bug_pattern`, `confidence=0.95`,
  `source_task_id=task_vYAVMaIs1-CkyvxN`)
- 검색 검증: Mem0 FTS `MATCH 'timeout'`이 위 ID를 반환했고,
  knowledge base exact-ID 조회가 1행을 반환했다.
- rollback: 위 두 ID만 각각 삭제하면 이번 장기 기억 연동을 되돌릴 수 있다.

## 검증 영수증

- [변경] `docs/self-improve/sns-rootcause-2026-07-24.md` — 실제 DB
  11개 task와 감사 경계를 기록한 개선 노트 신규 작성.
- [코드 변경] 없음. 팀 삭제·비활성화·lifecycle 변경 없음.
- [DB 재현] 고정 창 raw 완료 10/terminal 11=90.9%;
  delivered-report 중복 제외 후 10/10=100.0%.
- [T1 교차근거] `work_reports.wr_pW-n8916p5xH2fQZ` =
  `status=submitted`, `source_task_id=task_C-Vh4cAIgGrKNTd_`;
  `agent_actions`의 provider 전환·timeout·완료 이벤트 확인.
- [기존 수정] commit `aa30b09a`에 delivered-report 제외와 범위 가드
  회귀 테스트 존재.
- [장기 기억] `mem0-1784872498652-falybd` 저장 및 FTS 검색 확인;
  `kb-sns-rootcause-20260724` 1행 저장 확인.
- [타입체크] `npx tsc --noEmit` → exit 0, 오류 출력 없음.
- [관련 테스트]
  `npx vitest run src/core/team-scorer.test.ts src/server/task-intake.test.ts`
  → 2 files, 24 tests pass.
- [빌드] `npm run build` → exit 0 (`tsc`).
- [등급] T1 — 운영 SQLite 행, git commit 내용, 문서 파일 직접 확인.
- [Gap] 90% — 고정 표본과 기존 scorer 가드 적용은 재현했다. 독립
  auto-audit 로그는 0행이고 신규 Gate 계약의 실제 후속 응답은 아직 없다.
- [미검증항목]
  - `score_recovered=95.1` 이벤트 metadata에 없는 completion 세부값.
  - 신규 `team_sns` cron prompt 계약의 운영 반영과 재시도 감소율.
  - 운영 CB 룰 번호와 독립 False Report 감사 판정(데이터 부재).

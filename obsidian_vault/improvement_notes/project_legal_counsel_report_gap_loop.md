# project_legal_counsel_report_gap_loop

> 갱신: 2026-07-24 15:21 · Legal Counsel 개선 cycle 3/3 (최종)

## 확정된 원인 경계

Legal Counsel 상시 보고는 텍스트 중심이므로 코드 diff가 없는 것이
정상이다. 그러나 **diff 부재 자체가 team completion을 낮춘다는 기존
표현은 부정확하다.**

- 응답 품질 게이트는 protocol prefix 부재를 `FORMAT_MISMATCH`로 판정할
  수 있다.
- 팀 completion 스코어러는 diff를 검사하지 않고 terminal task 중
  `status=completed`를 센다.
- 2026-07-24 cycle 3 고정 표본에서 `FORMAT_MISMATCH` 다섯 행은 모두
  completed여서 completion 직접 감점이 아니다.

## cycle 3 T1 정정

HR 스냅샷 `score=80.7`, `completion=83.3%`, `48h/12`의 결손은 같은
업무보고의 중복 팬아웃 두 건이다.

- 논리 보고서: `workReportId=wr_B_FILi2kqsq5pXeA`
- 완료: `task_Uasm_GiCyMDLxPgX`
- 빈 출력 중복 실패: `task_16ZXX8QzyJw4zASb`,
  `task_ZSC7LeEtTTkuzdUP`
- 산출물: `REPORTS/legal-counsel/2026-07-24-오전.md`

같은 보고서는 실제로 제출됐다. 물리 task 세 개를 성공 1·실패 2로 세어
논리 산출물 하나를 세 번 평가한 것이 10/12의 직접 원인이다.

## 이후 분석 규칙

1. `FORMAT_MISMATCH`와 completion 실패를 분리한다. completed 품질 반려를
   status 실패로 다시 세지 않는다.
2. work-report 실패는 `team_id + workReportId` 계보를 먼저 묶고, 완료
   사본과 실제 REPORTS 파일 존재를 확인한다.
3. 완료 사본이 없는 단독 빈 출력은 실제 실패로 유지한다.
4. 텍스트 전용이라는 이유만으로 build/diff 증거를 만들거나 점수 원인을
   추정하지 않는다.
5. score·completion·n은 `team_lifecycle_events`와 고정 시간창의
   `tasks` 행으로 재현하며, 현재 시각의 이동 창과 혼합하지 않는다.

## 관련 문서

- [[legal-counsel-rootcause-2026-07-24]]
- [[team-legal-counsel-cycle1-20260724]]
- `docs/self-improve/legal-counsel-rootcause-2026-07-24.md`

## 라이프사이클 경계

분석 문서는 팀 상태를 변경하지 않는다. cycle 3 이후 HR scheduled
retirement 이벤트가 존재하며 삭제·비활성·복구 판단은 HR만 수행한다.

## Cycle 3/3 확정 (2026-07-24 15:21)

`WORK_REPORT_DUP_DELIVERED_EXCLUSION`(`team-scorer.ts:245-248`)은 실제 DB에서
유효하게 동작함이 T1 확인됐다:

- 적용 전: terminal_48h=12, completed=10 → 83.3%
- 적용 후: terminal_48h=10, completed=10 → 100%
- 변화는 정확히 workReportId `wr_B_FILi2kqsq5pXeA`의 중복 사본 2건이 제외된 차이
- 동일 회귀 테스트(`team-scorer.test.ts:187-213`) 통과 확인

**팀은 05:00 HR retirement됨**(`tle_PJuRDYdxmJqDZ66o`). 복구는 HR 전용.


# 03 Static Extraction Implementation 개선 기록 — 2026-07-23

## 범위와 결론

- 대상 팀: `team_web-scrape-03-static-implementation`
- HR 입력값: score 47.2, completion 50%, sample 48h/2
- DB 재확인: 최근 48시간 terminal task 2건 중 completed 1건
- 결론: 관측된 실패는 정적 추출 결과의 기능 실패가 아니라, 성공한 워커 결과를 task 상태기계가 완료로 기록하지 못한 운영 결함이다.

## 근거

1. `tasks` 행 `task_YXMsLSGPvWsIDI16`
   - 최종 상태: `failed`
   - 오류: `orphaned: server restart (poison — requeued 2x)`
   - `orphan_requeue_count=2`
2. PM2 원시 로그 `/Users/nova-ai/.pm2/logs/nco-backend-out-0.log`
   - line 3433821: 동일 task의 verification gate가 `passed=true`
   - line 3433824: 완료 기록이 `prev="queued"`, `next="completed"`에서 `Skipped terminal completion update`
3. 코드 경로
   - `src/index.ts`의 startup recovery는 orphan task를 `queued`로 되돌린다.
   - 기존 `TaskQueueManager.startRuntime`은 lease ack와 activity만 기록하고 `queued/assigned -> running` 전이를 기록하지 않았다.
   - `src/core/task-state.ts`는 `queued -> completed` 직접 전이를 허용하지 않으므로, 복구 task가 실제 성공해도 완료 기록이 거부됐다.
4. False Report 교차검증
   - `false_reports` 전체 행 수는 0이다. 따라서 이번 실패를 등록된 False Report 건수로 주장할 근거는 없다.
   - `nova_audit_log`의 현존 13건은 policy/emergency/citizen 이벤트이며 이 task 상태 전이의 직접 증거가 아니다.
   - 이전 개선 파이프라인 응답은 존재하지 않는 `src/renderer/index.css` 편집을 주장했고 `FORMAT_MISMATCH`로 반려됐다. 해당 응답은 원인 증거에서 제외했다.

## 변경

- `src/core/task-queue.ts`
  - 워커 실행 시작 시 lease ack 후 task를 `running`으로 전이한다.
  - 전이가 거부되면 이전 상태와 함께 경고를 남긴다.
- `src/core/lease-sweeper.test.ts`
  - 복구된 `queued` task가 워커 시작 후 `running`, 이후 `completed`로 전이되는 DB 회귀 테스트를 추가했다.

## 검증 영수증

- `npm test -- --run src/core/lease-sweeper.test.ts src/core/task-queue.p11.test.ts src/core/task-queue.verifier-cwd.test.ts`
  - 결과: test files 3 passed, tests 12 passed
- `npm run build`
  - 결과: `tsc` exit code 0
- 증거 등급: T1 (DB 행, 원시 로그, 파일 내용, 실제 명령 출력)
- 미검증:
  - NCO API가 실행 중이 아니어서 live HTTP/재시작 E2E는 수행하지 않았다.
  - 과거 실패 행과 HR lifecycle 상태는 수정하지 않았고 score 상승을 주장하지 않는다.
  - 팀 삭제·비활성화·retirement 변경은 수행하지 않았다.

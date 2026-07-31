# Nova-AX 정기 감사 증거 보고

- 회사: `org_technology-porting`
- 팀: `team_tech-port-07-value-gate-report`
- 감사 대상 원본 작업: `task_QWziltLgea4US5tr`
- 증거 등급: Tier 1 (SQLite 행, 파일 내용·SHA-256, 명령 출력)

## 현재 결론

신규 검증 제출 및 NCO 완료 결박은 아직 수행되지 않았다. 대상 작업은 NCO 원장에서
`reviewing`, `verificationStatus=pending`, `completed_at=NULL`이다. Nova-AX 원장에는
이 taskId에 귀속된 run과 receipt가 각각 0건이다.

## 실제 산출물 검증

대상 작업의 응답은 직전 감사 대상 `task_pximRcfB6RefFcJF`의 완료 결박을 보고한다.
그 응답의 SHA-256은 `578c5128ba53cc69bf1b6f3b2a9980c566be38793f1dd3a797f4bdf4e497a380`이다.

응답의 핵심 주장은 원장과 파일에서 다음과 같이 일치했다.

- 과거 run `vrun_9e1ec892-98cb-45bc-b9be-20c311740d1e`: `approved`, 6/6
- 과거 receipt `vrcpt_0933c4d8-1190-4dba-8855-bca47c09d95b`: 소비 행 1건
- 과거 loop `vloop_4c2e82d4-6d1b-42d9-a1ec-4b69d295e26a`: `completed`
- 과거 attempt `vattempt_7d6d1614-18c3-4038-8edd-8a628cdc4359`: `approved`
- 실제 팀 산출물 SHA-256:
  `dc5475cdbab96a2234067260082c859eb8a2caa3612ce19748852c478e25a1b7`

위 과거 영수증은 다른 taskId에 귀속되고 이미 소비되었으므로 현재 작업에 재사용할 수 없다.

## 업무보고 의무

최신 완료 보고일인 2026-07-30의 회사·팀 AM/PM 4건은 모두 `submitted`다.
그러나 전체 원장에는 `missed` 또는 `pending`인 미수신 행이 10건 남아 있다.

- 회사: `missed` 7건, `pending` 1건
- 팀: `missed` 2건
- 팀 `late` 1건은 제출되었으므로 미수신 10건 계산에서 제외했다.

따라서 “모든 회사·팀의 모든 역사적 보고 의무 수신”은 충족됐다고 주장할 수 없다.

## 반시드 루프

현재 회사·팀 범위에서 `action_required` 또는 `resubmitted` 상태의 열린 루프는 0건이다.
현재 taskId 자체에 귀속된 loop도 0건이다.

## 재검증

```bash
bash evidence/org_technology-porting/team_tech-port-07-value-gate-report/2026-07-31/task_QWziltLgea4US5tr/verify-ground-truth.sh
```

기대 출력의 핵심:

```text
ground_truth_assertions=13/13
target_status=reviewing
target_verification=pending
target_runs=0
target_receipts=0
scope_open_loops=0
latest_2026-07-30_reports_submitted=4/4
historical_unreceived_reports=10
```

## 미검증·차단

- `POST /api/verification/runs`의 신규 HTTP 응답
- 신규 6개 기관 판정과 receiptId
- `POST /api/tasks/task_QWziltLgea4US5tr/verification` 응답
- 신규 receipt 소비 행과 완료 이벤트
- 원본 작업의 `completed` 전이

호스트 프로세스는 6200/6300을 LISTEN하지만 현재 도구 실행 환경의 네트워크 연결은
`EPERM` 또는 HTTP 000으로 차단된다. Nova-AX/NCO MCP 요청도 실행 전에 취소되었고,
사용 가능한 브라우저 백엔드는 0개였다. DB 직접 수정이나 이미 소비된 영수증 재사용으로
검증 게이트를 우회하지 않았다.

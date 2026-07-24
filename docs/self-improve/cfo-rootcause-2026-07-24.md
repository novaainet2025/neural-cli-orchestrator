---
title: "Chief Financial Officer 48h/11 근본원인 — cycle 1"
date: 2026-07-24
team_id: team_cfo
team_slug: cfo
improvement_cycle: 1
snapshot_utc: "2026-07-24 05:00:00"
score: 87.3
completion: 90.9
sample: 48h/11
evidence_tier: T1
obsidian_note: "[[team-cfo-cycle1-20260724]]"
mem0_key: project_team_cfo_cycle1_duplicate_work_report_timeout
tags:
  - nco/self-improve
  - cfo
  - work-report
  - duplicate-fanout
  - scorer
---

# Chief Financial Officer 48h/11 근본원인 — cycle 1

## 결론

HR 스냅샷의 completion `90.9%`는 완료 10건과 `timed_out` 1건을
물리 task row 단위로 센 `10/11`이다. 결손 1건은
`task_nOh_b4GnVr1r1IuJ`이다.

이 태스크는 heartbeat가 61회 기록된 실제 실행 타임아웃이므로
`lease_expired`, heartbeat-NULL, never-ran은 아니다. 그러나 같은 팀,
같은 prompt, 같은 `workReportId=wr_iRaNIyiaBq7orx3I`의 형제
`task_3TlVeMIGK2jZIDk7`가 이미 정상 완료했다. 논리 업무인 CFO 오후
보고서는 배달됐고, 스케줄러가 만든 두 번째 물리 사본만 15분 뒤
`timeout(idle)`로 종료됐다.

따라서 직접 근본원인은 **동일 work report 중복 팬아웃을 독립 업무 실패로
센 스코어러 분모 오염**이다. CFO의 재무 데이터소스 부재,
`FORMAT_MISMATCH`, lease 만료가 이 `9.1%p` 결손의 원인은 아니다.

## 데이터 출처와 고정 창

- HR 원본 이벤트:
  `team_lifecycle_events.id=tle_u0y2ogYkil_Coat6`,
  `created_at=2026-07-24 05:00:00 UTC`, `score=87.3`,
  `metadata_json={"sample":"48h","n":11,"completion":90.9,...}`.
- 고정 창:
  `2026-07-22 05:00:00 <= tasks.created_at <= 2026-07-24 05:00:00 UTC`.
- 전용 `nco_list_tasks`/`nco_get_task` 커넥터는 현재 세션에 노출되지
  않았다. `localhost:6200/api/tasks`도 조회 시 연결 거부 상태여서 두
  API가 읽는 원천 저장소 `db/nco.db`를 `sqlite3 -readonly`로 조회했다.
- 실제 스키마의 팀 열은 요청 예시의 `team`이 아니라 `team_id`다.
  `WHERE team_id='team_cfo'`로 조회했다.

아래의 상태·오류·메타데이터·시각은 DB row 직접 확인에 근거한 T1이다.
API 응답과 현재 실행 중 서비스의 배포 버전은 T1로 확인하지 못했다.

## task_id별 상태와 근본원인 분류

| task_id | status | agent | spawner | 근본원인 태그 | T1 근거 |
|---|---|---|---|---|---|
| `task_7E33DlEDGPocP2jL` | completed | agy | work-report-scheduler | `SUCCESS_REPORT` | `completed_at=07:08:39`, heartbeat 14 |
| `task_66oH-d-UdiVH750w` | completed | cursor-agent | claude-2-measure2 | `SUCCESS_AFTER_FORMAT_RETRY` | `qualityHeuristics=["FORMAT_MISMATCH"]`, 최종 completed |
| `task_Yql1vIkZmTrsG6ve` | completed | claude-code | company-orchestrator | `SUCCESS_WITH_FORMAT_SIGNAL` | `qualityHeuristics=["FORMAT_MISMATCH"]`, 최종 completed |
| `task_59G6PVo50_iGd48f` | completed | claude-code | team-runner | `SUCCESS_TEAM_REPORT` | `error IS NULL`, heartbeat 6 |
| `task_Qx8pE8DTFnHMI7Xf` | completed | claude-code | work-report-scheduler | `SUCCESS_WITH_FORMAT_SIGNAL` | `qualityHeuristics=["FORMAT_MISMATCH"]`, 최종 completed |
| `task_3TlVeMIGK2jZIDk7` | completed | opencode | work-report-scheduler | `SUCCESS_DELIVERED_SIBLING` | `workReportId=wr_iRaNIyiaBq7orx3I`, `completed_at=05:02:14` |
| `task_nOh_b4GnVr1r1IuJ` | **timed_out** | opencode | work-report-scheduler | **`DUPLICATE_REPORT_ACTIVE_TIMEOUT`** | 같은 workReportId, `error=timeout(idle)`, heartbeat 61, `completed_at=05:17:11` |
| `task_BYJVrzZ3grAGuUPR` | completed | nvidia | commander-perfgoal | `SUCCESS_CONTROL_PLANE` | `qualityHeuristics=["FORMAT_MISMATCH"]`, 최종 completed |
| `task_JNne61TjU3P9_250` | completed | opencode | team-runner | `SUCCESS_TEAM_REPORT` | `error IS NULL`, heartbeat 5 |
| `task_AP8JV8sKsZ3vaMnT` | completed | opencode | work-report-scheduler | `SUCCESS_DUPLICATE_REPORT` | `workReportId=wr_p2MGFBgnU1tsVLh1`, 최종 completed |
| `task_GzzBfxCcaaWjuHb1` | completed | opencode | work-report-scheduler | `SUCCESS_DUPLICATE_REPORT` | 같은 `wr_p2MGFBgnU1tsVLh1`, 최종 completed |

표의 시각은 각 행의 UTC `created_at` 날짜 문맥을 따른다. 실패 행 하나를
제외한 열 건은 모두 terminal `completed`다.

## 결손 1건의 단계별 증거

| 단계 | 완료 형제 `task_3TlVeMIGK2jZIDk7` | 결손 행 `task_nOh_b4GnVr1r1IuJ` |
|---|---|---|
| 생성 | `2026-07-23 05:01:46` | `2026-07-23 05:01:51` |
| 논리 업무 키 | `team_cfo` + `wr_iRaNIyiaBq7orx3I` | 동일 |
| prompt | CFO 2026-07-23 오후 보고 | byte-for-byte 동일 |
| 실행 | ack + heartbeat 7 | ack + heartbeat 61 |
| 종료 | `completed`, `05:02:14` | `timed_out`, `05:17:11` |
| error | NULL | `timeout(idle)` |
| 산출물 배달 | response 3,411 bytes, verifier build passed | response 304 bytes, verifier 없음 |

형제 완료가 결손 행보다 약 15분 먼저 확정됐다. 그러므로 물리 실행의
타임아웃 자체는 실제지만, 같은 논리 보고서의 미완료를 뜻하지 않는다.

## 재발 패턴 분류

### 1. 중복 work-report 팬아웃 — 직접 원인

고정 창에는 중복 `workReportId` 그룹이 두 개 있다.

- `wr_iRaNIyiaBq7orx3I`: completed 1 + timed_out 1.
  이 timed_out 사본이 `10/11=90.9%`의 정확한 결손이다.
- `wr_p2MGFBgnU1tsVLh1`: completed 2.
  completion을 낮추지는 않지만 논리 업무 한 건을 물리 성공 두 건으로 세어
  표본량을 부풀리는 같은 팬아웃 계열 신호다.

### 2. lease_expired / heartbeat-NULL / never-ran — 원인 아님

고정 창의 `lease_expired`는 0건이고, ack 이후 heartbeat가 없는 terminal
행도 0건이다. 결손 행에는 heartbeat 61회가 있으므로 기존
`LEASE_NEVER_RAN_EXCLUSION` 대상으로 분류하면 안 된다.

### 3. FORMAT_MISMATCH — 관측됐지만 completion 결손 원인 아님

11개 중 7개 completed 행의 `metadata_json.qualityHeuristics`에
`FORMAT_MISMATCH`가 있다. 7개 모두 최종 상태가 completed이고, 유일한
timed_out 행에는 이 신호가 없다. 따라서 현재 요청 머리말의 품질게이트
반려나 과거 포맷 재시도를 CFO의 90.9% 원인으로 소급하지 않는다.

다만 quality-rejected 메타데이터가 남은 행도 completed로 집계되는 계약은
완료 판정과 품질 판정의 의미가 어긋날 수 있는 별도 관측성 과제다. 이번
결손 1건과는 분리한다.

### 4. 재무 데이터소스 부재 — 업무 리스크이나 status 실패 원인 아님

CFO 일일보고는 예산 baseline, 비용 원장, 거래 유출입 방향 등이
미주입됐다고 정직하게 기록했다. 그러나 관련 team-runner 태스크는
completed이며 이 데이터 갭 때문에 failed/timed_out이 된 DB 행은 없다.
따라서 데이터소스 부재는 후속 재무 품질 과제이지 completion 결손의
근본원인이 아니다.

## 스코어러 교차검증과 surface & hold

스냅샷 당시 DB row의 원시 집계는 terminal 11, completed 10,
completion 90.9%로 HR 이벤트와 정확히 일치한다.

이 분석 중 확인한 현재 HEAD `aa30b09ac2d665070368780bbb194f635a85ea7f`
(`2026-07-24 05:22:34 UTC`, HR 스냅샷 22분 뒤)는
`src/core/team-scorer.ts`에 이미 다음 일반 가드를 추가했다.

- 같은 `team_id`와 비어 있지 않은 `workReportId`의 completed 사본이
  존재할 때 non-completed 형제만 terminal 분모에서 제외한다.
- completed 행은 제외하지 않아 `completed <= terminal` 불변식을
  유지한다.
- 완료 형제가 없는 단독 실패는 그대로 실패로 집계한다.
- 롤백은 `WORK_REPORT_DUP_DELIVERED_EXCLUSION`,
  `DELIVERED_WORK_REPORTS_JOIN`, terminal CASE 세 곳의 삽입부 제거다.

고정 CFO 스냅샷에 현재 소스 조건을 SQL로 적용하면, 위 timed_out 중복과
별도의 completed control-plane perf-goal 행이 제외되어 terminal 9,
completed 9, completion 100.0%다. 이것은 **고정 DB 스냅샷에 대한
반사실 계산**이며, 운영 점수가 회복됐다는 주장이 아니다.

같은 일반 수정이 이미 존재하므로 CFO 예외 코드나 중복 가드를 새로 만들지
않는다. 현재 NCO API가 중단되어 실행 서비스가 이 commit을 로드했는지,
다음 HR score event가 어떤 값을 기록할지는 **[미검증]**이다.

## bounded / reversible 후속 방향

자가개선팀은 재작업 대신 다음 경계를 유지해야 한다.

1. 스코어러에는 현재의 `(team_id, workReportId, completed sibling)`
   조건보다 넓은 텍스트/agent 기반 예외를 추가하지 않는다.
2. 재발 자체는 work-report-scheduler가 동일 논리 보고서를 여러 task로
   생성하는 경로에서 별도로 계측한다. `wr_p2MGFBgnU1tsVLh1`처럼 둘 다
   completed인 중복도 있으므로 실패 문자열만으로는 탐지할 수 없다.
3. 서비스 복구 후 `GET /api/tasks`, CFO team score, 새 lifecycle event를
   읽기 전용으로 확인한다. 배포나 프로세스 재시작은 이번 자가학습 범위에
   포함하지 않는다.
4. 팀 삭제·비활성화·retirement·lifecycle status 변경은 하지 않는다.

## Obsidian / Mem0·memory 연결

- 개선 노트:
  [[team-cfo-cycle1-20260724|team_cfo duplicate work-report timeout 개선 노트]]
- 재발방지 교훈:
  [[team-cfo-cycle1-20260724#Mem0/memory 재발 방지 교훈]]
- 제안 memory key:
  `project_team_cfo_cycle1_duplicate_work_report_timeout`

Mem0 API는 NCO API 중단으로 이번 턴에 영속화하지 못했다. 존재하지 않는
Mem0 ID를 만들지 않았으며, 위 Obsidian 앵커를 검증 가능한 canonical
memory로 사용한다.

## 재현 SQL

```sql
SELECT id, status, assigned_to, spawned_by_cli, error,
       json_extract(metadata_json, '$.workReportId') AS work_report_id,
       json_extract(metadata_json, '$.qualityHeuristics') AS quality_heuristics,
       acked_at, last_heartbeat_at, heartbeat_seq,
       length(response) AS response_len, created_at, completed_at
FROM tasks
WHERE team_id = 'team_cfo'
  AND julianday(created_at) >=
      julianday('2026-07-24 05:00:00', '-48 hours')
  AND julianday(created_at) <= julianday('2026-07-24 05:00:00')
  AND status IN ('completed','failed','timed_out','lease_expired')
ORDER BY julianday(created_at), id;
```

```sql
SELECT json_extract(metadata_json, '$.workReportId') AS work_report_id,
       COUNT(*) AS rows,
       SUM(status='completed') AS completed,
       SUM(status='timed_out') AS timed_out,
       GROUP_CONCAT(id || ':' || status, ' | ') AS task_rows
FROM tasks
WHERE team_id = 'team_cfo'
  AND julianday(created_at) BETWEEN
      julianday('2026-07-24 05:00:00', '-48 hours')
      AND julianday('2026-07-24 05:00:00')
  AND json_valid(metadata_json)
  AND TRIM(COALESCE(
        json_extract(metadata_json, '$.workReportId'), ''
      )) <> ''
GROUP BY json_extract(metadata_json, '$.workReportId');
```

## 검증 영수증

- [변경] `docs/self-improve/cfo-rootcause-2026-07-24.md` — 고정 48h/11
  task row, 결손 행, 원인 분류, 기존 가드 교차검증 기록.
- [변경] `obsidian_vault/improvement_notes/team-cfo-cycle1-20260724.md`
  — Obsidian 개선 노트 및 canonical memory 교훈.
- [변경 없음] source, DB row, team/lifecycle 상태. 기존 일반 가드가 있어
  CFO 전용 코드 diff를 만들지 않음.
- [검증방법] `sqlite3 -readonly db/nco.db` 고정 창 재집계 →
  terminal 11, completed 10, completion 90.9, timed_out 1,
  lease_expired 0, never-ran 0.
- [검증방법] 동일 workReportId 그룹 조회 →
  `wr_iRaNIyiaBq7orx3I` completed 1 + timed_out 1.
- [검증방법] 현재 소스 가드의 고정 창 SQL 적용 →
  terminal 9, completed 9, completion 100.0.
- [검증방법] `npx vitest run src/core/team-scorer.test.ts` →
  테스트 파일 1개, 테스트 5개 통과.
- [검증방법] `npx tsc --noEmit` → exit 0, stdout/stderr 없음.
- [검증방법] `npm run build` → `tsc`, exit 0.
- [검증방법] `PRAGMA quick_check` → `ok`;
  `git diff --check -- <두 산출물>` → exit 0.
- [등급] T1 — SQLite 원본 행, git object, 파일 내용, 명령 출력 직접 확인.
- [Gap] 운영 재측정은 완료로 주장하지 않는다.
- [미검증항목] `nco_list_tasks`/`nco_get_task` HTTP 응답, 실행 서비스의
  `aa30b09` 로드 여부, 다음 48시간 score/completion, Mem0 API 영속화,
  scheduler 중복 생성의 최초 호출 스택.

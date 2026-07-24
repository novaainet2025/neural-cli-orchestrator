# Team 01 Source Discovery 중복 오류·False Report 교차검증

> 대상: `team_tech-port-01-source-discovery`  
> 기준 스냅샷: `tle_6KDnBODHJQjHaPbh`, 2026-07-24 02:10:00 UTC  
> 추출 시각: 2026-07-24 11:49:04 KST  
> T1 원본: `/Users/nova-ai/project/nco/db/nco.db`의 `tasks`,
> `retry_counts`, `agent_actions`, `agent_invocations`, `verification_gates`,
> `false_reports`, `hourly_role_audits`, `logs`, `circuit_states`,
> `team_lifecycle_events`와 Git 파일·커밋  
> 안전 경계: 팀 활성 상태, 라이프사이클, 은퇴 상태는 변경하지 않았다.

## 판정 요약

- lifecycle 원문은 `score=85.3`, `n=14`, `completion=85.7`이다. 같은
  48시간 terminal 표본은 `completed=12`, `failed=2`로 `12/14=85.7%`와
  일치한다.
- raw 완료 12건 중 6건에 `qualityRejected=true`,
  `qualityHeuristics=["FORMAT_MISMATCH"]`가 남아 있다. raw 완료와 품질
  통과는 같은 뜻이 아니다.
- 동일 `workReportId=wr_DYA0HpE3mdlzTGpc`와 완전히 같은 prompt를 가진
  부모 task 3건이 8초 안에 생성됐고 셋 모두 `FORMAT_MISMATCH`였다. 각
  부모가 retry child를 하나씩 만들어, 세 child가 모두 같은
  `Circuit breaker open for agent claude-code (generic)` 오류로 실패했다.
- 품질 반려 부모 6건은 각각 retry 1회를 생성했다. child 결과는 완료 1,
  서버 재시작 poison 실패 2, 동일 circuit-open 실패 3이며, 6건 모두
  `team_id=NULL`이다. 하나의 품질 문제를 교정하는 과정이 팀 계보 밖의
  추가 작업과 실패로 증폭됐다.
- 이전 오류방지 보고 `task_2ljDyjd9cNUuTUPc`가 근거로 든
  `task_asiMXefGtGP5S_Bx`, `task_hUNTQqo7U7ZQMcS4`,
  `task_xOq47PDqTq1fUnB2`는 모두 `team_id=NULL`이고 2026-07-11~12에
  생성됐다. team 01의 이 48시간 표본 근거가 아니다.
- team 01을 직접 가리키는 기준 시점 이전 48시간 `hourly_role_audits`,
  `logs`, `false_reports` 행은 모두 0건이다. 따라서 승인된 auto-audit
  판정이나 CB 룰 번호는 **데이터 미주입**이며 새 번호를 만들지 않는다.
- 최초 자가학습·자가개선 자연어 보고는 모두 `FORMAT_MISMATCH`이고
  `evidence_json=NULL`이다. 후속 Git 패치와 검증 가능한 노트는 존재하지만,
  최초 보고가 완료된 뒤 만들어진 변경을 최초 보고의 증거로 소급하지 않는다.

`localhost:6200`은 조회 시 연결 거부 상태였다. `nco_list_tasks`와
`nco_get_task` HTTP wrapper 대신 같은 API의 원천 저장소인 `db/nco.db`를
읽기 전용으로 조회했다. API 동작과 운영 재실행은 `[미검증]`이다.

## (a) 중복 오류 목록과 T1 task_id

| 오류 시그니처 | 빈도 | 부모 task_id | child task_id·결과 | T1 판정 |
|---|---:|---|---|---|
| 동일 업무보고 동시 중복 + `FORMAT_MISMATCH` | 3 | `task_clcf6LKHo7dSTMS_`, `task_02dHVv7xgJHs-FS5`, `task_j7eaD8UBVMf3jPtQ` | `task_P3xgH_ax-bn19bjD`, `task_iNsUWAFv0AEq9jSf`, `task_7anGtEZOv242DRMo` — 모두 `claude-code` circuit open | 동일 `workReportId`, prompt 1종, 생성 간격 8초 |
| 그 밖의 완료 상태 `FORMAT_MISMATCH` | 3 | `task_vy2Ny2KU2cYiX0_G`, `task_3Rv3e25qX07enR1f`, `task_Fb04BOuy_oyxT5i5` | `task_KiO4PNant1SwOejf` 완료, `task_zniMQDCD4SK65frt`·`task_GprBt2Slcqy2qPBt` poison 실패 | build 성공과 응답 포맷 성공이 분리됨 |
| quality retry의 팀 귀속 유실 | 6 | 위 품질 반려 부모 6건 | child 6건 모두 `team_id=NULL` | 교정 결과가 팀 성과·피드백 계보에서 누락 |
| raw 상태 실패: 필수 입력/산출물 불일치 | 1 | `task_zrtJeLH7fGDdUfiP` | child 없음 | `unknown: failure pattern in output` |
| raw 상태 실패: 서버 재시작 poison | 1 | `task_whudc2vYe2g_1YHf` | child 없음 | `orphaned: server restart (poison — requeued 2x)` |

### 중복 업무보고 계보

| 부모 | 생성 시각 UTC | raw 상태 | 품질 상태 | retry child | child 오류 |
|---|---|---|---|---|---|
| `task_clcf6LKHo7dSTMS_` | 00:04:32 | completed | `FORMAT_MISMATCH` | `task_P3xgH_ax-bn19bjD` | `Circuit breaker open for agent claude-code (generic)` |
| `task_02dHVv7xgJHs-FS5` | 00:04:40 | completed | `FORMAT_MISMATCH` | `task_iNsUWAFv0AEq9jSf` | 동일 |
| `task_j7eaD8UBVMf3jPtQ` | 00:04:40 | completed | `FORMAT_MISMATCH` | `task_7anGtEZOv242DRMo` | 동일 |

세 부모의 response는 서로 다르므로 “같은 응답 3회”가 아니라 **같은 보고
의도와 prompt의 동시 중복 발행**이다. `retry_counts.count=1`도 각 물리
parent 기준이어서 논리적 업무보고 하나에 총 3개의 retry가 허용됐다.

### 품질 반려 부모→retry 전체

| parent | child | child agent | child 상태·오류 |
|---|---|---|---|
| `task_vy2Ny2KU2cYiX0_G` | `task_KiO4PNant1SwOejf` | codex | completed |
| `task_3Rv3e25qX07enR1f` | `task_zniMQDCD4SK65frt` | opencode | failed, poison requeue 2x |
| `task_Fb04BOuy_oyxT5i5` | `task_GprBt2Slcqy2qPBt` | codex | failed, poison requeue 2x |
| `task_clcf6LKHo7dSTMS_` | `task_P3xgH_ax-bn19bjD` | claude-code | failed, circuit open |
| `task_02dHVv7xgJHs-FS5` | `task_iNsUWAFv0AEq9jSf` | claude-code | failed, circuit open |
| `task_j7eaD8UBVMf3jPtQ` | `task_7anGtEZOv242DRMo` | claude-code | failed, circuit open |

## auto-audit·CB 데이터 경계

기준 스냅샷 이전 48시간의 team 01 직접 참조 행은 다음과 같다.

| 소스 | 관측 행 |
|---|---:|
| `hourly_role_audits` | 0 |
| `logs` | 0 |
| `false_reports` | 0 |
| `verification_gates` | 42 |

`verification_gates`는 task별 L1/L2/L3 상태를 담지만 승인된 CB 규칙
레지스트리나 False Report 판정은 아니다. `circuit_states`는 조회 당시의
provider 상태만 보존하며 역사 스냅샷이 아니다. 따라서 child task의 저장된
오류 문구는 당시 circuit-open의 T1 증거지만, 현재 `claude-code=closed` 행을
당시 상태의 증거로 사용하지 않는다.

## (b) CB·Gate 갱신 제안

아래 이름은 설명용이며 정식 CB 식별자가 아니다. auto-audit/승인 레지스트리
데이터가 없으므로 **룰 번호는 데이터 미주입으로 미부여**한다.

### 활성 업무보고 idempotency gate — 구현됨

- 적용 조건: `metadata.workReportId`가 있고 같은 ID의 task가
  `pending|queued|assigned|running|streaming|reviewing` 상태일 때.
- 동작: 새 task 대신 기존 `taskId`와 `deduplicated=true`를 반환한다. 동시
  요청 경쟁은 부분 unique index `idx_tasks_active_work_report_id`가 막는다.
  기존 task가 terminal 상태가 된 뒤의 명시적 retry는 허용한다.
- 근거: `wr_DYA0HpE3mdlzTGpc` 부모 3건이 8초 안에 중복 생성됐다.
- 현재 상태: commit `e0a786f54437a91c45602080cc3f09c9e1bfa2bf`의
  `src/server/gateway.ts`, `src/server/task-intake.ts`,
  `src/server/task-intake.test.ts`,
  `db/migrations/085_active_work_report_task_idempotency.sql`. DB에는 migration
  id 100이 `2026-07-24 02:22:50 UTC`에 적용됐고 index가 존재한다.
- 되돌리기: commit 전체에는 다른 변경도 있으므로 전체 revert하지 않는다.
  위 idempotency 관련 hunk와 테스트만 되돌리고, 승인된 migration rollback에서
  `DROP INDEX IF EXISTS idx_tasks_active_work_report_id`를 실행한다. task 데이터는
  삭제하지 않는다.

### Team 01 protocol·evidence contract gate — 구현됨

- 적용 조건: `metadata.teamId=team_tech-port-01-source-discovery`.
- 동작: 완료는 첫 줄 `done:`, 미완료는 `status:`와 `[미검증]`으로 시작하게
  하고 URL, version/commit, 검증일, license/security, 대안을 요구한다. marker로
  재진입 시 중복 삽입을 막는다.
- 근거: 품질 반려 6건 모두 verifier가 protocol prefix를 요구했지만 원 prompt에
  계약이 없었고, 응답 첫 줄도 계약을 만족하지 않았다.
- 현재 상태: commit `b5bbf4d62951655709b017c40f7aca78449d7978`의
  `src/server/task-intake.ts`와 테스트에 범위 제한 구현이 존재한다.
- 되돌리기: 해당 commit의 Team 01 상수, `applyTeamResponseContract` 호출,
  관련 테스트 hunk만 되돌린다. 다른 팀과 lifecycle 상태는 건드리지 않는다.

### 논리적 계보 단위 quality-retry hold — 제안, 미구현

- 적용 조건: 같은 `workReportId`가 있으면 이를 논리적 root로 사용하고, 같은
  heuristic(`FORMAT_MISMATCH`)의 retry가 이미 생성됐을 때. `workReportId`가
  없으면 기존 root parent lineage를 사용한다.
- 동작: 논리적 root별 같은 heuristic retry는 가용 provider로 최대 1회만
  허용한다. 후보 circuit이 열렸거나 가용하지 않으면 새 child를 만들지 않고
  `hold` 사유와 누락된 포맷 필드를 기록한다. 전역 retry cap은 늘리지 않는다.
- 근거: 중복 부모 3건이 각각 retry를 만들어 같은 circuit-open 실패 3건으로
  증폭됐다.
- 되돌리기: logical-root heuristic hold 분기와 단위 테스트만 제거해 기존
  physical-parent별 retry cap으로 복귀한다.

### 품질 상태 일관성 report gate — 제안, 미구현

- 적용 조건: `metadata_json.qualityRejected=true`.
- 동작: DB raw 상태가 `completed`여도 대시보드·HR 근거·완료 보고에서는
  “품질 통과”로 표현하지 않고 `raw completed / quality rejected`로 분리한다.
  score 산식 변경은 별도 HR 승인 전 수행하지 않는다.
- 근거: 14개 표본의 raw 완료 12건 중 6건이 `FORMAT_MISMATCH`인데도
  `status=completed`로 남아 있다.
- 되돌리기: 표시·집계 projection만 제거한다. task 행과 lifecycle 상태는
  수정하지 않는다.

## (c) 자가학습·자가개선 보고 신뢰도 교차검증

### 자가학습 `task_1AsVZ1sjOk-76aW_` — 불충족 / T4 완료서술

| 항목 | T1 관측 | 판정 |
|---|---|---|
| raw 상태·품질 | `completed`, `qualityRejected=true`, `FORMAT_MISMATCH` | 품질 PASS 아님 |
| 응답 | 도구 이름과 Fable/Team/Tool Use 내용을 설명 | 실패 task_id·빈도·상관 패턴 없음 |
| 도구 기록 | 완료 이벤트에 `toolCalls=4`; 개별 호출·인자·결과 없음 | 호출 성공 검증 불가 |
| 검증기 | `npm run build` exit 0 | 문서 내용·DB 분석 검증이 아님 |
| 증거 | `evidence_json=NULL` | T1 task 근거 없음 |
| 동시 Git | commit `fed5957`이 task 실행 중 Fable/Team/Tool Use 29행 문서를 생성 | 파일 존재만 T1; 요청 산출물 내용은 불충족 |

후속 commit `b5bbf4d`가 11:45 KST에 이 문서를 실제 DB 근거 노트로
교체했지만, 최초 task는 11:11:58 KST에 끝났다. 후속 교정은 최초 자연어
보고의 root-cause 완료 증거로 소급하지 않는다.

### 자가개선 `task_YDO7MW5lu5C9MdFu` — 의심 / 미검증 성공 주장

| 항목 | T1 관측 | 판정 |
|---|---|---|
| raw 상태·품질 | `completed`, `qualityRejected=true`, `FORMAT_MISMATCH` | 품질 PASS 아님 |
| 응답 | “root cause identified”, “bounded, reversible fix implemented” 한 문장 | 경로·diff·rollback·검증 로그 없음 |
| 도구 기록 | 완료 이벤트에 `toolCalls=9`; 개별 호출·인자·결과 없음 | 실제 수정·검증 호출 유무 확인 불가 |
| 검증기 | `npm run build` exit 0; L1 pass, L2 skip, L3 pass | 현재 worktree build만 증명 |
| 요구 검증 | 관련 vitest, `npx tsc --noEmit`, diff 영수증 | task 행에 별도 실행 증거 없음 |
| 증거 | `evidence_json=NULL`, `false_reports` 해당 행 0 | 공식 False Report 판정 데이터 부재 |
| Git 시간 대조 | task 완료 11:13:16 KST, idempotency commit 11:22:25, Team 01 contract commit 11:45:06 | 후속 patch를 최초 보고에 귀속 불가 |

악의적 허위라고 확정할 auto-audit 행은 없지만, 요구한 완료 조건을 충족했다는
보고로는 신뢰할 수 없다. 판정은 **의심(미검증 성공 주장, T4)** 이다. 후속
커밋의 패치 실재는 별도로 T1 확인되며 최초 보고의 판정을 바꾸지 않는다.

### 이전 오류방지 보고 `task_2ljDyjd9cNUuTUPc` — 근거 부적합

이 task가 열거한 세 task는 실제 `FORMAT_MISMATCH` 행이지만 team 01 귀속과
48시간 기간 조건을 모두 만족하지 않는다. 이 보고 자체도
`qualityRejected=true`, `FORMAT_MISMATCH`, `evidence_json=NULL`이다. 따라서
현재 오류방지 판정의 근거에서 제외한다.

## T1 재현 쿼리

```sql
SELECT id, assigned_to, status, error, parent_task_id, team_id,
       json_extract(metadata_json,'$.qualityRejected') AS quality_rejected,
       json_extract(metadata_json,'$.qualityHeuristics') AS heuristics,
       json_extract(metadata_json,'$.workReportId') AS work_report_id
FROM tasks
WHERE team_id='team_tech-port-01-source-discovery'
  AND status IN ('completed','failed')
  AND created_at >= datetime('2026-07-24 02:10:00','-48 hours')
  AND created_at <= '2026-07-24 02:10:00'
ORDER BY created_at;
```

```sql
SELECT p.id AS parent_id, c.id AS child_id, c.team_id, c.status, c.error,
       r.count AS retry_count
FROM tasks p
JOIN tasks c ON c.parent_task_id=p.id
LEFT JOIN retry_counts r ON r.task_id=p.id
WHERE p.id IN (
  'task_vy2Ny2KU2cYiX0_G', 'task_3Rv3e25qX07enR1f',
  'task_Fb04BOuy_oyxT5i5', 'task_clcf6LKHo7dSTMS_',
  'task_02dHVv7xgJHs-FS5', 'task_j7eaD8UBVMf3jPtQ'
);
```

## 검증 영수증

- [변경] `docs/self-improve/tech-port-01-duplicate-error-2026-07-24.md` —
  실제 task/retry/audit/Git 근거로 중복 오류, Gate 제안, False Report
  교차검증을 기록.
- [검증방법] SQLite 재현 쿼리, 관련 Vitest, `npx tsc --noEmit`,
  `npm run build`, `git diff --check`.
- [등급] T1 — SQLite 원본 행, Git commit/file 내용, 실제 명령 출력.
- [Gap] NCO API가 꺼져 있어 실제 동시 HTTP 중복 요청과 수정 prompt의 운영
  재실행을 검증하지 못했다. auto-audit/CB 룰 번호는 데이터 미주입이다.
- [미검증항목] 개선 후 48시간 score/completion 효과, 운영 동시성,
  quality-retry hold 제안, 최초 두 task의 개별 도구 호출 상세.

### 실측 로그

```text
$ npx vitest run src/server/task-intake.test.ts tests/response-quality.test.ts
Test Files  2 passed (2)
Tests       23 passed (23)
Duration    856ms
exit code   0
```

```text
$ npx tsc --noEmit
(출력 없음)
exit code 0
```

```text
$ npm run build
> neural-cli-orchestrator@1.0.0 build
> tsc
exit code 0
```

```text
$ git diff --check -- docs/self-improve/tech-port-01-duplicate-error-2026-07-24.md
(출력 없음)
exit code 0
```

검증 시점의 worktree에는 다른 동시 작업자가 수정한
`src/server/task-intake.ts`, `src/server/task-intake.test.ts`,
기존 team 01 패턴 노트와 HNSW index 파일들이 이미 있었다. 이 문서는 해당
변경을 수정·stage·commit하지 않았다.

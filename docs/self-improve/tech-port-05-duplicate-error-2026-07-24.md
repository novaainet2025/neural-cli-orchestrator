# Team 05 Upgrade Regression 중복 오류·False Report 교차검증

> 대상: `team_tech-port-05-upgrade-regression`  
> 추출 시각: 2026-07-24 11:26:57 KST  
> 원본: `/Users/nova-ai/project/nco/db/nco.db`의 `tasks`, `agent_actions`,
> `agent_invocations`, `retry_counts`, `verification_gates`, `false_reports`,
> `hourly_role_audits`, `logs`, `circuit_states`  
> 표본: 최근 48시간에 생성된 대상 팀 task 11건  
> 안전 경계: 팀 활성 상태·라이프사이클·은퇴 상태는 조회하거나 변경하지 않았다.

## 판정 요약

- 원시 `tasks` 상태는 `completed=7`, `failed=4`로, 지시문에 주입된 완료율
  `63.6%`(`7/11`)와 일치한다. score `64.7`의 재계산은 이 문서 범위 밖이며
  별도 실측하지 않았다.
- 실패 4건 가운데 3건은 같은 `workReportId`, 완전히 같은 prompt, 같은
  `Circuit breaker open for agent claude-code (generic)` 오류를 가진 중복
  업무보고 태스크다. 이 세 건은 7초 안에 생성됐다.
- 나머지 실패 1건은 서버 재시작 orphan이며 `orphan_requeue_count=2`다. 이는
  산출물 품질 실패와 분리해야 한다.
- 완료 7건 중 2건에는 `qualityRejected=true`와
  `qualityHeuristics=["FORMAT_MISMATCH"]`가 함께 남아 있다. 따라서 원시 완료
  상태만으로 품질 성공을 주장할 수 없다.
- 이번 개선 사이클의 자가개선 보고 `task_QmHVWtjzw8VJJmrW`는 **의심**이다.
  완료 상태와 build 통과 기록은 있으나, 실제 대상 diff·롤백·관련 vitest·
  `evidence_json`이 없고 응답 자체도 `FORMAT_MISMATCH`로 반려됐다.
- team 05를 직접 가리키는 최근 48시간 `hourly_role_audits`와 `logs` 행은 각각
  0건이다. 따라서 등록된 CB 룰 번호나 auto-audit 판정은 **데이터 부재**이며
  새 번호를 부여하지 않는다.

## (a) 중복 오류 목록과 T1 task_id

| 분류 | 빈도 | 근거 task_id | DB 원문 요약 | 판정 |
|---|---:|---|---|---|
| 동일 업무보고 중복 발행 후 동일 CB 오류 | 3 | `task_YFLrIEQLd1i6TO7X`, `task_wGQUej5jn9Cq4hB8`, `task_lrmDmI-hFYZIi8Rp` | 세 행 모두 `workReportId=wr_XPaRG3BF-5fxoUzO`, prompt 완전 동일, 생성 `00:05:01`·`00:05:01`·`00:05:08` UTC, 오류 `Circuit breaker open for agent claude-code (generic)` | 직접 중복 실패 |
| 서버 재시작 orphan 재큐잉 | 1 | `task_dv3_5lUEO181NKlE` | `error=orphaned: server restart (poison — requeued 2x)`, `orphan_requeue_count=2` | 인프라 실패; 품질 실패와 분리 |
| 완료 상태에 남은 `FORMAT_MISMATCH` | 2 | `task_RSYX40DOFx91XC4G`, `task_8nOuGiIxyz6yoKxq` | 두 행 모두 `status=completed`, `qualityRejected=true`, `qualityHeuristics=["FORMAT_MISMATCH"]`; verifier는 `npm run build` exit 0 | 완료/품질 상태 불일치 |
| 이번 개선 사이클의 `FORMAT_MISMATCH` 재발 | 2 계보 | `task_QmHVWtjzw8VJJmrW` → `task_F_iDWkcDL8m3xFRw`; `task_O3HdsIpV_1P_dMUl` → `task_8-UU78GLsGFw8Cji` | 앞 task가 완료 직후 `FORMAT_MISMATCH`로 표식되고, `retry_counts.count=1` 및 quality-reject 접두사를 가진 자식 task 생성 | 품질 반려 재시도 루프 |

### 에이전트별 원시 상태

| 에이전트 | 완료 | 실패 | 품질 반려가 붙은 완료 | 근거 |
|---|---:|---:|---:|---|
| `codex` | 3 | 0 | 0 | `task_yd1URC03SWl0ZX1I`, `task_eDZX1ktjEsDwKSd7`, `task_8pdjdAAZEPbt6JLA` |
| `retired-provider` | 3 | 0 | 2 | `task_dqKn0QBUAhoS416d`, `task_RSYX40DOFx91XC4G`, `task_8nOuGiIxyz6yoKxq` |
| `opencode` | 1 | 0 | 0 | `task_FjDSf4_zLeJbWQcE` |
| `claude-code` | 0 | 3 | 0 | 위 동일 업무보고 3건 |
| `ollama` | 0 | 1 | 0 | `task_dv3_5lUEO181NKlE` |

### 상관 패턴

1. 동일 `workReportId`의 중복 발행과 실패 증폭이 같이 나타난다. 세 태스크 모두
   `codex` queue wait 1,800,000ms 뒤 `claude-code`로 failover됐고 같은 CB 오류로
   종료됐다. 하나의 보고 의도가 실패 3건으로 집계됐다.
2. `npm run build` 성공은 응답 포맷 성공과 상관되지 않았다.
   `task_RSYX40DOFx91XC4G`와 `task_8nOuGiIxyz6yoKxq` 모두 build exit 0이지만
   `FORMAT_MISMATCH`다.
3. provider 실행 완료와 요구 산출물 완료도 분리돼야 한다.
   `task_QmHVWtjzw8VJJmrW`는 executor의 완료 이벤트와 build 통과가 있으나,
   요구된 patch·vitest·rollback 증거가 없고 품질 반려됐다.

## (b) CB·Gate 갱신 제안

아래 항목은 정식 CB 식별자가 아니다. team-specific auto-audit 행과 승인된 CB
레지스트리 번호가 없어 **규칙 번호는 데이터 부재로 미부여**한다.

### 활성 업무보고 idempotency gate

- 적용 조건: `metadata.workReportId`가 비어 있지 않고, 같은 ID의 task가
  `pending|queued|assigned|running|streaming|reviewing` 중 하나일 때.
- 동작: 새 task를 만들지 않고 기존 `taskId`를 `deduplicated=true`로 반환한다.
  DB에도 활성 상태 부분 unique index를 둬 동시 요청 경쟁을 차단한다.
- terminal 재시도: 기존 task가 `completed|failed|timed_out|lease_expired|cancelled`
  상태가 된 뒤에는 새 task를 허용한다.
- 현재 소스 상태: 관측된 실패 뒤 commit
  `e0a786f54437a91c45602080cc3f09c9e1bfa2bf`에
  `db/migrations/085_active_work_report_task_idempotency.sql`,
  `src/server/task-intake.ts`, `src/server/gateway.ts` 구현과
  `src/server/task-intake.test.ts` 회귀 테스트가 들어왔다. 이 커밋은
  `task_QmHVWtjzw8VJJmrW` 완료 뒤 생성됐으므로 자가개선 보고의 산출물로
  귀속하지 않는다.
- 되돌리기: 해당 커밋의 세 경로 변경을 revert하고
  `DROP INDEX IF EXISTS idx_tasks_active_work_report_id`를 승인된 마이그레이션
  절차로 실행한다. 운영 데이터 삭제는 없다.

### failover 직전 circuit 재확인 gate

- 적용 조건: `queue_wait_timeout` 뒤 다른 provider로 failover하려는 순간.
- 동작: 후보 선택 시점뿐 아니라 enqueue 직전에
  `circuitBreakerRegistry.getAvailability(candidate).available`을 다시 확인한다.
  열려 있으면 그 후보를 건너뛰고 아직 시도하지 않은 다음 후보를 선택한다.
  같은 `workReportId` 계보에는 동시에 하나의 failover만 허용한다.
- 근거: 위 3개 중복 task는 모두 `codex` 대기 후 CB가 열린 `claude-code`에서
  즉시 같은 오류로 종료됐다.
- 구현 상태: **제안만 함, 미구현**.
- 되돌리기: failover 직전 재확인 분기와 해당 테스트만 제거해 기존 후보 선택
  로직으로 복귀한다. 팀·라이프사이클 상태에는 영향이 없다.

### 증거 계약 completion gate

- 적용 조건: prompt가 patch/diff, rollback, `npx tsc --noEmit`, 관련 vitest를
  명시한 코드 변경 task일 때만 opt-in한다.
- 동작: 완료 전 `evidence_json`에 변경 경로, diff/commit 식별자, 각 명령·exit
  code가 있어야 한다. 누락 시 executor가 끝났더라도 `completed` 성공 보고를
  채택하지 않고 `reviewing` 또는 명시적 evidence-rejected 상태로 보류한다.
  일반 텍스트 보고에는 적용하지 않는다.
- 근거: `task_QmHVWtjzw8VJJmrW`는 build만 통과했고 `evidence_json`이 비어
  있는데도 완료 상태가 먼저 기록됐다.
- 구현 상태: **제안만 함, 미구현**.
- 되돌리기: 해당 task의 `requiredEvidence` opt-in을 제거하면 기존 완료 흐름으로
  돌아간다.

### 동일 heuristic quality-retry hold

- 적용 조건: 같은 원본 계보에서 같은 `FORMAT_MISMATCH`가 반복되고, 새 응답이
  도구 설명/`<thinking>`/이전 응답 echo 패턴인 경우.
- 동작: 다른 가용 provider로 한 번만 재시도한 뒤 같은 heuristic이면 새 task를
  더 만들지 않고 hold와 누락 필드를 기록한다. 현재 전역 retry cap 3을 우회하지
  않으며 cap을 늘리지 않는다.
- 근거: `task_QmHVWtjzw8VJJmrW`와 `task_O3HdsIpV_1P_dMUl`이 완료 직후 같은
  heuristic의 재시도를 각각 만들었다.
- 구현 상태: **제안만 함, 미구현**.
- 되돌리기: heuristic별 hold 분기를 제거하면 기존 lineage retry cap 3 로직으로
  복귀한다.

## (c) 자가개선 보고 신뢰도 교차검증

### 판정: 의심

대상은 `task_QmHVWtjzw8VJJmrW`다.

| 확인 항목 | T1 관측 | 판정 |
|---|---|---|
| 최종 상태 | `status=completed` | executor 종료만 증명 |
| 품질 상태 | `qualityRejected=true`, `FORMAT_MISMATCH` | 품질 PASS 아님 |
| 도구 호출 | `agent_actions`의 완료 이벤트에 `toolCalls=4` | 호출 횟수는 있으나 개별 도구·인자·결과가 없어 성공 검증 불가 |
| 검증기 | `npm run build`, exit 0, output에 `tsc` | build만 확인 |
| 요구된 명령 | `npx tsc --noEmit`, 관련 vitest | 별도 실행 증거 없음 |
| 변경 증거 | `evidence_json` NULL, 응답에 대상 diff·commit·rollback 없음 | patch 완료 주장 불가 |
| verification gates | L1 typecheck pass, L2 lint skip, L3 change ratio pass; detail은 `{}` | 대상 변경의 실재를 증명하지 못함 |
| False Report 테이블 | 해당 task 행 0건 | 감사 판정 데이터 부재; PASS 의미 아님 |
| git 시간대 대조 | task 실행 11:11:36–11:13:32 KST 사이 commit은 team 01/02 작업이며 team 05 patch 없음 | task 귀속 patch 미확인 |

응답은 실제 변경 경로·diff 대신 `searchCode`, `editFile`, `writeFile` 등의 일반
설명을 반복하고, 범위 밖 `/Users/nova-ai/project/nova-use/...` 편집을 서술한다.
따라서 악의적 허위라고 확정할 감사 데이터는 없지만, 요청된 완료 조건을
충족했다는 보고로는 신뢰할 수 없다. `false_reports` 행이 생길 때까지 공식
판정은 **의심(미검증 완료 보고)** 으로 유지한다.

### 후속 재시도에서 나타난 실제 diff

위 최초 보고가 끝난 뒤 같은 워크트리에 별도 미커밋 변경
`src/core/company-orchestrator.ts`, `src/core/company-orchestrator.test.ts`,
`docs/self-improve/tech-port-05-upgrade-regression-fix-2026-07-24.md`가
나타났다. 이 diff는 team 05 handoff에서 현재 지시를 이전 단계 출력보다 먼저
두고, 이전 출력 경계와 `done:`/`status:` 계약을 추가한다. T1 task
`task_RSYX40DOFx91XC4G`, `task_8nOuGiIxyz6yoKxq`의 상류 출력 echo와
`FORMAT_MISMATCH`에 직접 대응하는 bounded patch다.

독립 재실행한 관련 vitest는 54/54 통과했고 typecheck/build도 통과했다. 그러나
이 변경은 `task_QmHVWtjzw8VJJmrW` 완료 뒤 나타났고 아직 commit이 없으며,
task_id와 파일 write의 귀속 로그도 없다. 따라서 **후속 패치는 검증 가능하지만
최초 자가개선 보고의 판정은 의심으로 유지**한다. 이 문서는 동시 작업자의 세
파일을 수정하거나 커밋하지 않았다.

## T1 재현 쿼리

```sql
SELECT id, assigned_to, status, parent_task_id, orphan_requeue_count,
       created_at, completed_at, error,
       json_extract(metadata_json,'$.workReportId') AS work_report_id,
       json_extract(metadata_json,'$.qualityRejected') AS quality_rejected,
       json_extract(metadata_json,'$.qualityHeuristics') AS heuristics,
       evidence_json, verifier_json, verifier_result_json
FROM tasks
WHERE team_id='team_tech-port-05-upgrade-regression'
  AND created_at >= datetime('now','-48 hours')
ORDER BY created_at;
```

```sql
SELECT COUNT(*)
FROM hourly_role_audits
WHERE created_at >= datetime('now','-48 hours')
  AND (
    subject_id='team_tech-port-05-upgrade-regression'
    OR checks_json LIKE '%tech-port-05-upgrade-regression%'
    OR evidence_json LIKE '%tech-port-05-upgrade-regression%'
  );
-- 관측값: 0
```

## 검증 영수증

- [변경] `docs/self-improve/tech-port-05-duplicate-error-2026-07-24.md` — 실제
  task_id 기반 중복 오류, CB/Gate 제안, 자가개선 신뢰도 판정 기록.
- [검증방법] 아래 검증 로그에 실제 명령·exit code를 기록한다.
- [등급] T1 — SQLite 원본 행, git commit/file 내용, 실제 명령 출력.
- [Gap] 런타임 NCO API(`localhost:6200`)는 추출 당시 연결 불가였다. 새
  idempotency gate의 실제 HTTP 동시 요청 검증, 승인된 CB 룰 번호, team-specific
  auto-audit 판정은 미검증이다.
- [미검증항목] score 64.7 계산식 재현, 개선 후 completion/score 변화,
  프로덕션 failover 동시성, `task_QmHVWtjzw8VJJmrW`의 4개 도구 호출 상세.

### 검증 로그

```text
$ npx vitest run src/server/task-intake.test.ts tests/response-quality.test.ts src/core/work-report-scheduler.test.ts
Test Files  3 passed (3)
Tests       29 passed (29)
Duration    664ms
exit code   0
```

```text
$ npx vitest run src/core/company-orchestrator.test.ts tests/response-quality.test.ts
Test Files  2 passed (2)
Tests       54 passed (54)
Duration    705ms
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

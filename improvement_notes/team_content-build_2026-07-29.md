# NCO Team Improvement Note: team_content-build (고품질 콘텐츠 제작팀)
Date: 2026-07-29

## 1. 근거 위치 (Evidence Locations)
- DB: `/Users/nova-ai/project/nco/db/nco.db`
- 대상 테이블: `tasks`
- 팀 식별자: `team_content-build` (고품질 콘텐츠 제작팀)

## 2. 검증 결과 및 수치 (Verified Findings)
- **전체 작업 수**: 13 (completed: 7, failed: 5, cancelled: 1)
- **정당한 선행조건 차단이 일반 실패로 분류된 사례 (Legitimate Blocks Classified as Failures)**: 2건
  - `task_eMva63ao2fjDYEaX` (failed, `failure-pattern: agent reported error`)
  - `task_jX5LC9uaq8hTO4kP` (failed, `failure-pattern: agent reported error`)
  - (에이전트가 올바르게 근거팩 부재를 판단하고 작업을 차단했으나, 시스템이 이를 단순 작업 실패로 기록하여 팀 성공률 점수를 하락시킴)
- **Blocker Fingerprint**:
  - `error: BLOCKED — 승인된 근거팩이 없어 제작을 진행할 수 없습니다.`
  - `error: BLOCKED — 승인된 근거팩(1차출처 자료)이 없어...`
  - (주요 원인: `evidence-packs.yaml` 내 `approval_status: INCOMPLETE` 상태)
- **중복 dispatch 및 실행자 교체 횟수 (Duplicate Dispatch / Requeue)**:
  - 1건 (`task_ju0xiKaQzhTaP4K3`의 `orphan_requeue_count` = 1)

## 3. 성공 및 실패 패턴 분석 (Success/Failure Pattern Analysis)
- **성공 패턴**: 1차 출처 근거가 승인된 작업(`approval_status`가 확인된 항목, 예: `task_Yn4NIuvuw60iXc7V`)에 대해서만 파일 및 콘텐츠 제작을 정상 수행함.
- **실패 패턴**: 안전 및 신뢰성을 최우선으로 하는 Fable Principles에 따라, 미승인된 근거(Incomplete Evidence)가 확인된 경우 에이전트는 올바르게 작업을 중단(Blocked)함. 그러나 NCO 워크플로우 시스템은 이러한 '정당한 선행조건 부족에 의한 중단'을 '작업 실패(failed)'로 분류하여 팀 성과(Score)의 부정확한 하락을 초래함.

## 4. 재현 절차 (Reproduction Steps)
1. `sqlite3 db/nco.db "SELECT id, status, error FROM tasks WHERE team_id = 'team_content-build' AND status = 'failed';"`
2. 오류 로그 중 "BLOCKED — 승인된 근거팩이 없어"를 포함한 작업 확인
3. `sqlite3 db/nco.db "SELECT orphan_requeue_count FROM tasks WHERE team_id = 'team_content-build' AND orphan_requeue_count > 0;"` 실행하여 중복 디스패치 확인

## 5. 재발 방지 학습 규칙 (Mem0 반영 후보 지식 목록 / Learning Rules)
1. **[팀 평가 규칙]** 팀(`team_content-build`)의 에이전트가 승인된 근거팩(`INCOMPLETE`) 부재로 인해 스스로 진행을 차단(BLOCKED)한 경우, 이를 팀의 역량 부족(failed)이 아닌 외부 종속성 대기(blocked/pending) 상태로 평가하고 점수 감점을 방지해야 한다.
2. **[작업 할당 규칙]** 콘텐츠 기획팀(content-planning)의 `evidence-packs.yaml` 승인이 완료되기 전에는 콘텐츠 제작팀에 작업을 디스패치하지 않도록 선행조건 검증 게이트(Delivery Gate)를 강화한다.

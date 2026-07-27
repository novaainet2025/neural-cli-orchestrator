# Continuous Learning 48h/5 근본원인 진단

> 대상: `gov-evolution-learning` / `team_gov-evolution-learning`  
> 기준 스냅샷: 2026-07-27 06:04:58 UTC (2026-07-27 15:04:58 KST)  
> 범위: HR 지시의 `score=75.7`, `completion=80%`, `sample=48h/5`, improvement cycle `1/3`  
> 분류 규칙: DB에 `evolution-governance`·`learning-cycle` 필드가 없으므로, `[업무보고 작성]` 프롬프트 3건을 `evolution-governance`, `[팀 상시 임무 — Continuous Learning]` 프롬프트 2건을 `learning-cycle`로 분석상 분류했다.

## 결론

**학습 루프의 주된 병목은 `미회수`다.** 원시 데이터는 `tasks`, `work_reports`, `learning_events`와 산출물 파일에 저장되어 있었지만, 5개 표본의 프롬프트에는 개별 task ID·결과·오류·구체적인 사용자 피드백 내용/연결 ID·검증 영수증·연결된 learning event가 한 건도 주입되지 않았다. 프롬프트의 팀 charter에는 “사용자 피드백”이라는 일반 임무 문구만 있었다. 따라서 `미활용`은 미회수의 하류 결과다. `result_json`·`evidence_json`과 승격된 학습 레코드가 없는 것은 별도의 구조화 저장 결손이지만, 원시 task 데이터 자체의 미저장이 75.7점의 직접 원인은 아니다.

**75.7점의 직접 산술 원인은 `evolution-governance` 업무보고 1건의 공백 출력 실패다.** 스냅샷의 5건은 완료 4건·실패 1건이어서 completion이 80%였다. 실패 행 `task_3eejRUftHpUXmdOH`은 `response`가 줄바꿈 8바이트뿐이고 `error='silent-failure: empty output'`이다. 당시 `maxN=82`를 적용한 실제 스코어 공식은 `round1(0.9 × 80 + 0.1 × (100 × log10(5) / log10(82))) = 75.7`이다.

이후 HR lifecycle DB에는 07:10:00 UTC `score_recovered=93.2`, 07:11:50 UTC `score_checked=93.7`이 기록됐다. 이는 후속 failover/재발행으로 표본 구성이 바뀐 결과이며, 학습 데이터 회수 규약이 수정됐다는 증거는 아니다. 이 노트는 팀 활성 상태·lifecycle·retirement를 변경하지 않는다.

## 증거 기준과 원천

- **[Evidence Tier 1] DB 행/내용 직접 확인:** `db/nco.db`의 `tasks`, `work_reports`, `learning_events`, `semantic_memory`, `improvement_notes`, `team_lifecycle_events`, `team_lifecycle_profiles`; `PRAGMA quick_check` 결과 `ok`. 스냅샷 event의 metadata는 `sample=48h`, `n=5`, `maxN=82`, `completion=80`이며, `completed_at <= 2026-07-27 06:04:58 UTC`로 재구성한 terminal 행도 완료 4건·실패 1건이다.
- **[Evidence Tier 1] 파일/코드 직접 확인:** `data/team-runner/team_gov-evolution-learning-2026-07-26.md`, `data/team-runner/team_gov-evolution-learning-2026-07-27.md`, `REPORTS/2026-07-27-Continuous-Learning-오전.md`, `REPORTS/2026-07-27-Continuous-Learning-오후.md`, `scripts/team-runner.sh`, `src/core/work-report-scheduler.ts`, `src/core/failure-learning.ts`, `src/core/team-scorer.ts`.
- **[Evidence Tier 4] 격리:** task 응답 내부의 “검증됨”, “0% 적용”, 다른 task 언급 등은 해당 응답의 자연어 주장일 뿐이다. 이번 진단에서 DB 행·파일 내용·코드로 독립 확인되지 않은 주장은 사실 근거로 승격하지 않았다.
- NCO HTTP `localhost:6200`은 이번 점검 시 연결 거부였다. 따라서 API 현재값은 근거로 사용하지 않았고, DB 스냅샷과 파일을 통제 원천으로 사용했다.

## 48h/5 task별 패턴

| task | 분석 분류 | 스냅샷 결과 | [Evidence Tier 1] 관찰 | 실패 원인·학습 판정 |
|---|---|---:|---|---|
| `task_53abN7hMCQcH5SrT` | evolution-governance | 완료 | `tasks.response` 699자와 `work_reports.body_md` 699자가 저장됨. 프롬프트에는 agent 성과 집계만 있고 개별 task 결과·오류·영수증은 없음. | 실행 성공. 출력은 오류 상세가 미제공이라고 적었지만 동시에 파일/HTTP 검증을 주장했고 `result_json`·`evidence_json`은 비어 있다. 자연어 검증 주장은 Tier 4로 격리. |
| `task_RQlrDP4SNwpAZOEP` | learning-cycle | 완료 | 응답 1,450자와 `data/team-runner/team_gov-evolution-learning-2026-07-26.md`가 저장됨. 입력은 팀 집계와 agent 상태뿐임. | 실행 성공. 개별 task 결과·사용자 피드백·실패 원인을 “미확인”으로 남긴 점은 안전한 패턴. 추출한 교훈은 구조화 학습 저장소에 연결되지 않음. |
| `task_-0trMvKZRQtsf1k3` | learning-cycle | 완료 | 응답 853자와 `data/team-runner/team_gov-evolution-learning-2026-07-27.md`가 저장됨. 입력에 task ID·오류·영수증 없음. | 상태상 성공이나, 응답의 “실패 패턴 분석 기능 0%”, `task_nYFMgk4lwKE6_Pr3` 언급은 주입 근거가 없어 Tier 4. 집계치만으로 학습을 생성하려 한 품질 실패 패턴. |
| `task_f1CCNcEiOGMMpq-Z` | evolution-governance | 완료 | 응답은 114자의 파일 포인터이며 실제 오전 보고서 파일이 존재함. `work_reports.body_md`에는 보고서 본문 대신 포인터 응답만 저장됨. | 실행·파일 생성 성공. 보고서 스스로 완료 task ID·상세 결과·학습 승격 기록이 제공되지 않았다고 진단. 원시 파일과 canonical report body 사이 내용 회수/수집 결손도 관찰됨. |
| `task_3eejRUftHpUXmdOH` | evolution-governance | 실패 | `response` 8바이트가 모두 공백 문자이고 `error='silent-failure: empty output'`; `result_json`·`evidence_json` 없음. 06:04:57 UTC `learning_events`에 failover dispatch가 기록됨. | **점수 하락 직접 원인(1/5, 전체의 20%; evolution-governance의 1/3).** 학습 내용의 저장/회수 실패 이전에 출력 생성 자체가 실패. 후속 재발행은 성공했지만 이 스냅샷에는 포함하지 않음. |

## 실패 빈도와 단계 판정

| 검사 | 관찰 빈도 | 판정 |
|---|---:|---|
| 스냅샷 terminal 성공 | 4/5 (80%) | HR completion과 일치 |
| 공백 출력 실패 | 1/5 (20%) | 75.7점의 직접 원인 |
| `tasks` 원시 행 저장 | 5/5 | 원시 task 미저장 아님 |
| 비공백 task 출력 저장 | 4/5 | 성공 task 출력은 보존됨 |
| `result_json` 존재 | 0/5 | 구조화 결과 저장 결손 |
| `evidence_json` 존재 | 0/5 | 구조화 증거 저장 결손 |
| 프롬프트에 `[recent_team_task]` task 단위 행 | 0/5 | **미회수** |
| 프롬프트에 learning event | 0/5 | **미회수** |
| 프롬프트에 구체적인 사용자 피드백 내용·출처·연결 ID | 0/5 | 일반 charter 문구만 존재; **미회수** |
| `semantic_memory`·`improvement_notes`의 5개 task ID 연결 | 0/5 | 승격 학습 저장 결손 |
| 스냅샷 시점 task-linked `learning_events` | 2/5 task, 3행 | 운영 이벤트는 저장됐으나 Continuous Learning 입력에 미회수; 3행 모두 `auto_applied=0` |

### 코드로 확인한 원인

1. `scripts/team-runner.sh:115-180`은 Continuous Learning 입력에 7일 task 상태 합계, work report 수, team/agent 집계만 넣는다. 개별 task 결과·오류·증거·learning event를 읽지 않는다.
2. `src/core/work-report-scheduler.ts:78-83`의 `SUBSTANTIVE_TASK_SLUGS`에 `gov-evolution-learning`이 없다. 따라서 `:216-234`의 제한된 최근 task 행조차 이 팀 보고서에는 들어가지 않는다. 해당 행도 현재는 `id/status/created_at/prompt`만 읽고 결과·오류·증거는 읽지 않는다.
3. `scripts/team-runner.sh:455-464`는 일반 팀 출력을 날짜별 markdown에 저장하지만, `improvement_notes` 기록은 `self-improvement` 팀에만 수행한다. Continuous Learning의 승격 교훈은 별도 구조화 레코드로 남지 않는다.
4. `src/core/failure-learning.ts:88-111`은 운영 실패를 `learning_events`에 저장하고, `:122-165`, `:205-231`은 동일 회로 오류가 3회 반복될 때 읽어 자동 적용한다. 즉 저장·활용 경로 자체는 존재한다. 문제는 Continuous Learning 보고/일일 cycle이 이 저장소를 회수하지 않는 데 있다.
5. `src/core/team-scorer.ts:331-397`은 48h terminal completion 90%와 상대 volume 10%로 점수를 계산한다. 따라서 학습 품질이 좋아도 공백 출력 1건은 당시 completion을 80%로 낮췄다.

## 권장 학습 루프 수정 방향

다음 수정은 **권장안이며 이 하위작업에서는 미구현**이다. 구현 주체는 HR lifecycle이 아니라 NCO 학습/보고 수집기여야 한다.

1. **회수 단계부터 국소 수정한다.** `gov-evolution-learning`에 한해 두 context builder가 최근 48시간 terminal task 최대 5건의 `id`, `status`, `completed_at`, `error`, 제한된 `response`, `result_json`, `evidence_json`, `json_extract(metadata_json, '$.workReportId')`를 읽도록 한다. `learning_events.context.taskId/sourceTaskId` 연결 행도 최대 10건으로 제한한다.
2. **Tier를 입력에 명시한다.** DB 필드·파일 본문은 Tier 1, task 응답 내부의 검증 주장은 Tier 4로 전달한다. `status='completed'`를 학습 검증 성공으로 승격하지 않는다.
3. **고정 출력 계약을 둔다.** 후보 학습마다 `source_task_ids`, `observed_fact`, `failure_stage`, `scope`, `expiry_condition`, `reverify_at`, `evidence_tier`를 요구한다. 필수 필드가 없으면 “격리”로 남기고 승격하지 않는다.
4. **저장과 활용을 분리 검증한다.** 검증된 후보만 task ID가 포함된 구조화 레코드로 저장하고, 다음 cycle에서 그 레코드가 실제 프롬프트에 다시 주입됐는지 별도 카운트한다. 운영 회로 학습은 기존 `learning_events` 3회 승격 규칙을 유지한다.
5. **회귀 테스트를 추가한다.** 성공 1건·공백 실패 1건·Tier 4 주장 1건 fixture로 (a) task ID/오류가 context에 포함됨, (b) 근거 없는 주장은 승격되지 않음, (c) 최대 5건/길이 제한, (d) 다른 팀 context 불변을 확인한다.

### 경계·안전·되돌리기

- 팀 삭제·비활성화·probation·retirement·lifecycle status 변경은 금지하며, 본 작업에서 해당 DB 행을 수정하지 않았다.
- 권장 구현은 `gov-evolution-learning` 조건 분기와 읽기 전용 조회로 제한하고 스키마 변경을 피한다.
- 구현 시 되돌리기는 두 context builder의 해당 분기와 전용 테스트만 제거하면 된다. 기존 `learning_events` 승격 규칙과 다른 팀 프롬프트는 건드리지 않는다.
- 이 노트 자체의 되돌리기는 `08-IMPROVEMENTS/gov-evolution-learning-rootcause.md` 추가를 되돌리는 것뿐이며 런타임 영향은 없다.

## 검증 영수증

- [변경] `08-IMPROVEMENTS/gov-evolution-learning-rootcause.md` — 48h/5 task별 Tier 판정, 빈도, 단계 진단, 권장 루프와 안전 경계 기록.
- [검증방법] `sqlite3 -readonly db/nco.db`로 컷오프 5행·lifecycle event·learning store 연결을 조회하고, 관련 파일과 context builder/score/learning 코드를 직접 읽어 대조. `run-delivery-gate.sh --full`에서 test 111 files/599 tests와 `npm run build`가 통과했고, `npm run build -- --noEmit`도 exit 0이었다.
- [등급] T1 — DB 행·파일 내용·코드·명령 출력을 현재 작업에서 직접 확인.
- [Gap] full delivery gate 집계는 기존 dirty 18건으로 inspection FAIL, 별도 `typecheck` script 부재로 SKIP을 포함해 `PASS=2 FAIL=1 SKIP=1`이었다. 선언된 build script의 `tsc --noEmit`은 별도 통과했다. 런타임 학습 context 수정은 이 하위작업 산출물 범위 밖이라 미구현. NCO `:6200` HTTP 통합 상태는 연결 거부로 미검증.
- [미검증항목] 다음 실제 learning cycle에서 task 단위 증거가 회수·승격·재사용되는지, 후속 score가 지속되는지.

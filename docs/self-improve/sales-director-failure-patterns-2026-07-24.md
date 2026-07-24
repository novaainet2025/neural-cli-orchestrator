# Sales Director 실패 패턴 — 개선 cycle 1/3

## 결론 — surface & hold

`team_sales-director`의 HR 스냅샷 `90% (9/10)`은 Sales Director의 독립
업무 10건 중 1건이 실패한 결과가 아니다. 유일한 포함 실패
`task_tewtyQQda5wCE5bm`은 `workReportId=wr_We202Mx0BA-qPXvd`의 업무보고
재시도 행이며, 같은 논리 업무에서 `task_Dmk_S2iv6COirInJ`와
`task_s_Hkj5UF3mdFpJ6H`가 완료됐다.

이 실패에는 Markdown 업무보고와 무관한 `npm run build` verifier가 붙었다.
전역 소스의 `TS2307` 오류로 verifier가 실패한 뒤 `ollama → nvidia` failover가
발생했고, 최종 상태는 timeout이었다. 즉 직접 근본원인은 **재시도 task 행을
독립 품질 표본으로 세는 집계 grain**과 **업무보고의 코드 작업 오분류**가 결합한
것이다.

현재 소스에는 두 재발 방지책이 이미 존재한다.

- commit `e0a786f`: 활성 task의 동일 `workReportId` 중복 intake 방지
- commit `014bdf6`: `[업무보고 작성]` 프롬프트에 기본 build verifier를 붙이지 않음

따라서 이번 자가학습 단계에서는 추가 scorer 예외나 팀 전용 면제를 만들지 않고
**surface & hold**한다. 팀 활성 상태와 lifecycle은 변경하지 않았다. 현재
운영 score가 회복됐다고 주장하지 않는다.

## 기준과 원천

- 대상: `team_sales-director` (`sales-director`)
- HR 기준 이벤트: `tle_4u1yaPnpFkROPs8t`
- 기준 시각: 2026-07-24 04:20:00 UTC (13:20:00 KST)
- HR 기록값: score `86.7`, completion `90%`, sample `48h/10`
- 제어 원천: `team_lifecycle_events`, 저수준 원천: `tasks`,
  `verification_gates`, `false_reports` in `db/nco.db`
- 근거 등급: T1 (DB 행 본문, verifier 원문, 소스·commit 원문)

`localhost:6200`의 `list_tasks`/`get_task` 경로는 조사 시 연결 거부였다. 동일
원천인 `db/nco.db`를 SQLite `-readonly`로 조회했고, HR 이벤트 시각을 상한으로
고정해 48시간 창을 재구성했다. API 응답과의 동시 교차검증은 미수행이다.

## HR 48시간 표본 재현

현재 scorer의 terminal 상태와 기존 인프라·제어면 제외식을 HR 기준 창에
적용하면 다음과 같다.

| 집계 | terminal | completed | completion |
|---|---:|---:|---:|
| raw task 행 | 12 | 9 | 75.0% |
| restart orphan·perfgoal 제어면 제외 | 10 | 9 | **90.0%** |
| 논리 charter 관찰값(운영 지표 아님) | 5 | 5 | **100.0%** |

마지막 행은 세 개의 고유 `workReportId`와 두 개의 `team-runner` 임무를 각각
한 논리 업무로 본 counterfactual이다. 운영 completion 또는 score가 실제로
100%가 됐다는 뜻이 아니다. `task_fJdL9O8eNtUlWTRb`는 Sales 업무가 아닌
회사 오케스트레이터의 모호한 제외 요청이어서 논리 charter 관찰값에서 제외했다.

score는 completion뿐 아니라 전체 팀 중 상대 task volume을 함께 사용한다.
따라서 completion과 n이 같은 상태에서도 HR score는 04:20의 `86.7`에서
04:50의 `86.3`으로 변했다. 이 문서는 HR 기준 이벤트의 저장값을 기준으로 하며
상대 volume 변동을 성능 개선이나 악화로 해석하지 않는다.

읽기 전용 재계산 시각 05:02:21 UTC에는 경계의 두 task가 48시간 창에서 빠져
`score=94.7`, `completion=100`, `n=8`이 반환됐다. 이는 이번 문서·Mem0 쓰기로
회복된 것이 아니라 rolling-window 만료 효과다. 같은 시점의 최신 저장 lifecycle은
05:00:00 UTC의 `86.2`, `90%`, `n=10`이므로 다음 scheduled HR 반영은 아직
미검증이다.

## 실 task 이력

| task ID | 생성 시각(UTC) | agent | spawner | 상태 | workReportId | scorer 판정 |
|---|---|---|---|---|---|---|
| `task_tewtyQQda5wCE5bm` | 2026-07-22 05:01:54 | nvidia | work-report-scheduler | failed | `wr_We202Mx0BA-qPXvd` | 포함 실패; 동일 논리 보고서 완료본 존재 |
| `task_Dmk_S2iv6COirInJ` | 2026-07-22 05:02:13 | ollama | work-report-scheduler | completed | `wr_We202Mx0BA-qPXvd` | 포함 완료 |
| `task_bEALeFnkTMkagAC_` | 2026-07-22 05:08:44 | ollama | work-report-scheduler | failed | `wr_We202Mx0BA-qPXvd` | restart orphan 제외 |
| `task_s_Hkj5UF3mdFpJ6H` | 2026-07-22 05:16:33 | ollama | work-report-scheduler | completed | `wr_We202Mx0BA-qPXvd` | 포함 완료 |
| `task_fJdL9O8eNtUlWTRb` | 2026-07-22 12:27:00 | claude-code | company-orchestrator | completed | 없음 | 포함 완료이나 charter 무관 |
| `task_nLraZU-cjOeeK4AC` | 2026-07-22 15:14:17 | ollama | team-runner | completed | 없음 | 포함 완료 |
| `task_ng224-3I8hqsWPiV` | 2026-07-23 00:01:58 | ollama | work-report-scheduler | completed | `wr_qEbvInqBn6MrGAKS` | 포함 완료 |
| `task_yKhVJi6k1skJyZzJ` | 2026-07-23 00:01:58 | ollama | work-report-scheduler | completed | `wr_qEbvInqBn6MrGAKS` | 포함 완료; 동일 보고서 중복 |
| `task_BpM-ajq1tjHDK7BZ` | 2026-07-23 11:38:19 | opencode | commander-perfgoal | failed | 없음 | restart orphan·제어면 제외 |
| `task_XPWhEt1zYjnEtCux` | 2026-07-23 15:21:35 | ollama | team-runner | completed | 없음 | 포함 완료 |
| `task_6wsxoE6VUfw3k_EY` | 2026-07-24 00:02:15 | ollama | work-report-scheduler | completed | `wr_Q9WFZ7jstphGX2gj` | 포함 완료 |
| `task_BPlXJLBlN2eH3tHS` | 2026-07-24 00:02:15 | ollama | work-report-scheduler | completed | `wr_Q9WFZ7jstphGX2gj` | 포함 완료; 동일 보고서 중복 |

세 고유 보고서가 raw task 8행으로 확장됐다. 특히
`wr_We202Mx0BA-qPXvd`는 completed 2행, failed 2행으로 저장됐다. 그중 orphan
1행은 scorer가 제외하지만 verifier/failover timeout 1행은 별도 실패로 남아
`9/10`을 만들었다.

## 에이전트별 성공·실패 패턴

| agent | raw terminal/completed | scorer terminal/completed | 증거 기반 해석 |
|---|---:|---:|---|
| ollama | 9/8 | 8/8 | scorer 포함 행은 모두 completed. 실패 1행은 restart orphan이다. 같은 보고서의 중복 완료가 반복됐다. |
| nvidia | 1/0 | 1/0 | `ollama` verifier 실패 후 재할당된 보고서 한 건이 timeout. 독립 Sales 작업 표본이 아니다. |
| claude-code | 1/1 | 1/1 | “이 목표에서 제외”의 대상을 되묻는 정상 응답이나 Sales charter와 무관하다. |
| opencode | 1/0 | 0/0 | `commander-perfgoal` restart orphan으로 현재 scorer에서 제외된다. |

상태 성공과 산출물 신뢰도는 별개다. 일부 completed ollama 보고서는 task prompt에
근거 데이터가 없는데도 “주요 고객 3개사 미팅”, “CRM 동기화 오류” 같은 구체
사실을 썼다. 반대로 7월 23일 보고서는 “구체 업무 내역을 확인할 수 없음”이라고
표현했다. 향후 Sales 보고는 후자의 정직한 미확인 패턴을 따라야 한다.

## 자동 감사·실패 원문 교차검증

`task_tewtyQQda5wCE5bm`의 저장 원문:

- `verifier_json`: `npm run build`, timeout 120초
- L1 typecheck: fail
- 오류: `src/server/routes/teams.ts(13,21): error TS2307: Cannot find module '../../config/env.js'`
- L3 change ratio: pass
- metadata: `requestedProvider=ollama`,
  `attemptedAgents=["ollama","nvidia"]`, `reassignedFrom=ollama`
- 최종 error: `The operation was aborted due to timeout`
- response/result/evidence: 비어 있음
- heartbeat: 11회 기록

이는 never-ran lease나 diff-ratio 오탐이 아니다. 보고서 생성과 무관한 전역
빌드 실패가 provider failover를 촉발했고, 재할당 실행이 timeout된 사건이다.

기준 창의 12개 target-team task에서 `FORMAT_MISMATCH` 문자열은 0건이고,
`false_reports` 연결 행도 0건이다. 현재 개선 파이프라인에서 보이는
`[Quality-gate reject: ... FORMAT_MISMATCH]` 재시도들은
`team_self-learning`에 귀속되어 있으므로 target-team의 `9/10` 원인으로
사용하지 않았다.

## 근본원인 가설 판정

| 가설 | 판정 | 근거 |
|---|---|---|
| Sales charter 작업 한 건이 실제로 실패했다 | 기각 | 유일 포함 실패와 동일 `workReportId`에 완료본 2건 존재 |
| text-only 결과가 diff 부재로 실패했다 | 기각 | L3 change ratio는 대상 verifier 행을 포함해 pass |
| FORMAT_MISMATCH가 90%를 만들었다 | 기각 | target-team 고정 창 0건 |
| restart orphan이 계속 감점됐다 | 기각 | 두 orphan 행은 12행 raw에는 있으나 10행 scorer 표본에서는 제외 |
| 업무보고가 코드 verifier로 오분류됐다 | 채택 | 저장된 `npm run build`, TS2307, failover history가 일치 |
| task-attempt grain이 동일 보고서 실패를 중복 계상했다 | 채택 | `wr_We202Mx0BA-qPXvd` 4행 중 완료본과 실패본 동시 존재 |
| team_id만으로 charter 관련성이 보장된다 | 기각 | `task_fJdL9O8eNtUlWTRb`는 무관한 company-orchestrator 요청 |

## bounded·reversible 대응 상태

추가 코드 변경은 하지 않았다.

1. `src/server/task-intake.ts`의 `isWorkReportPrompt` 가드는 정확한
   `[업무보고 작성]` 접두사에만 적용되고 기본 build verifier만 생략한다.
   명시 verifier와 다른 코드 작업은 유지된다. 롤백은 commit `014bdf6`의 해당
   가드와 테스트만 되돌리면 된다.
2. 동일 `workReportId`의 활성 task가 있으면 기존 task를 반환하는 generic
   intake dedupe가 존재한다. 롤백은 commit `e0a786f`의 helper와 gateway 적용부,
   테스트만 되돌리면 된다.
3. 과거 task를 scorer에서 소급 제외하는 `sales-director` 전용 규칙은 추가하지
   않았다. 현재 증거는 특정 팀 면제보다 논리 workReport grain의 일반 문제를
   가리키며, 급한 팀 전용 분기보다 기존 intake 재발 방지와 rolling-window
   관찰이 안전하다.

## Mem0 장기 기억 연동

NCO API가 연결 거부여서 `mem0-bridge`를 `NCO_MEM0_NO_EMBED=1`로 직접 호출했다.
agent/user는 `self-learning` / `team_sales-director`, batch는
`sales-director-cycle1-2026-07-24`다.

| Mem0 ID | 핵심 교훈 |
|---|---|
| `mem0-1784869145746-k6pffx` | 동일 `workReportId`의 retry 행을 독립 deliverable로 해석하지 않는다. |
| `mem0-1784869145746-szzwdf` | 업무보고에 코드 build verifier를 붙이지 않고 task-local 증거를 검증한다. |
| `mem0-1784869145746-3oghw0` | self-learning FORMAT 재시도와 target-team score 사건을 분리한다. |
| `mem0-1784869145747-8ry3m1` | Sales 근거가 없으면 고객·CRM·파이프라인 사실을 만들지 않고 unknown을 명시한다. |
| `mem0-1784869145747-usau17` | `team_id`만으로 charter 관련성을 가정하지 않는다. |

`mem0List`에서 5건과 metadata를 확인했고, BM25 검색 `workReportId`와
`verifier`로 관련 기억을 재조회했다. 임베딩은 의도적으로 생략했으며 semantic
검색은 미검증이다. 롤백은 위 5개 ID만 `self-learning` agent 범위에서
삭제하면 된다.

## 검증 영수증

- [변경] `docs/self-improve/sales-director-failure-patterns-2026-07-24.md`
- [HR 원문] `tle_4u1yaPnpFkROPs8t` → score `86.7`, completion `90`,
  sample `48h`, n `10`
- [DB 재계산] raw `9/12=75.0%` → scorer `9/10=90.0%`
- [논리 관찰] 고유 work report 3건 + team-runner 2건은 모두 완료본 존재
- [감사] target-team 기준 창 FORMAT_MISMATCH `0`, false_reports `0`
- [Mem0] 5건 저장·list·BM25 search 확인; `PRAGMA quick_check` → `ok`
- [관련 테스트] `npx vitest run src/server/task-intake.test.ts src/core/team-scorer.test.ts`
  → 2 files, 21 tests passed, exit 0
- [타입체크] `npx tsc --noEmit` → exit 0, 오류 0
- [build] `npm run build` → `tsc`, exit 0
- [live 재계산] 2026-07-24 05:02:21 UTC → score `94.7`,
  completion `100`, n `8`, sample `48h`; rolling-window 만료 효과
- [저장 lifecycle] 같은 시점 최신 이벤트 `tle_aRSHg15p2c28ehGw` →
  05:00 UTC score `86.2`, completion `90`, n `10`
- [lifecycle] 팀 `is_active=1` 확인, 변경 없음
- [미검증] 라이브 NCO API, 다음 scheduled HR score 반영, semantic embedding 검색,
  Obsidian vault 동기화

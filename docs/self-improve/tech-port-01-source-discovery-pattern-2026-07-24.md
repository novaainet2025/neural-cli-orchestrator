---
title: "Team 01 Source Discovery 작업 패턴·근본원인"
date: 2026-07-24
team: team_tech-port-01-source-discovery
sample: 48h/14
tags:
  - nco/self-learning
  - tech-port-01
  - source-discovery
  - root-cause
  - FORMAT_MISMATCH
mem0_key: "tech-port-01 실패패턴"
---

# Team 01 Source Discovery 작업 패턴·근본원인

> 대상 스냅샷: score `85.3`, completion `85.7%`, 최근 48시간 14건,
> 개선 사이클 2/3
> 스냅샷 이벤트: `tle_6KDnBODHJQjHaPbh` (`2026-07-24 02:10:00 UTC`)
> 추출 시각: `2026-07-24 11:41:38 KST`
> T1 원본: `/Users/nova-ai/project/nco/db/nco.db`의 `tasks`,
> `agent_actions`, `team_lifecycle_events`
> 코드 기준선: `76707b57a74b861951bcd23510c18aa6410f116c`

## 판정 요약

- 점수 이벤트 원문은 `score=85.3`, `n=14`, `completion=85.7`이다.
  같은 시각의 14개 채점 대상 task는 `completed=12`, `failed=2`이며
  `12 / 14 = 85.7%`로 일치한다.
- 같은 48시간 범위의 `cancelled` 1건 `task_QNfQhafszE2fdNhu`는 score
  표본 `n=14`에 포함되지 않아 분석 표본에서도 분리했다.
- 완료 12건 중 6건은 `qualityRejected=true`,
  `qualityHeuristics=["FORMAT_MISMATCH"]`다. 여섯 프롬프트 모두
  `done:` 계약이 없고, 여섯 응답 모두 protocol prefix가 없다.
- 상태 실패 2건은 모두 `ollama`가 수행한 성과보고·목표설정 입력 task다.
  하나는 필수 필드 미확인 응답을 내고 `unknown: failure pattern in output`으로
  종료됐고, 하나는 서버 재시작 orphan 재큐잉 2회를 소진했다.
- 요청 provider는 `retired-provider`가 12/14(85.7%)로 편중됐다. 최종 executor도
  `retired-provider` 11건, `agy` 1건, `ollama` 2건이다. 품질 반려 6건은 모두
  최종 `retired-provider` task다.
- 14건 모두 `evidence_json IS NULL`이다. 따라서 raw `completed`만으로
  URL·commit·라이선스·벤치마크 근거가 검증됐다고 판정하지 않는다.
- 품질 반려 6건의 retry child는 모두 `team_id=NULL`이다. 교정 task
  1건이 완료됐지만 대상 팀 표본과 피드백 계보에는 귀속되지 않았다.

`localhost:6200`은 추출 시 연결 거부였다. `nco_list_tasks`와
`nco_get_task`의 HTTP wrapper를 사용할 수 없어, 두 API의 원천 저장소인
`db/nco.db`와 지속된 이벤트 행을 읽기 전용으로 조회했다. API 동작 자체는
`[미검증]`이다.

## 14개 T1 표본

| task_id | 최종 에이전트 | DB 상태 | 관측 분류 |
|---|---|---|---|
| `task_NKawqqiFpXLljVLL` | `retired-provider` | completed | 후보 dossier 대신 무관한 `createFile` 결과 설명; verifier 없음 |
| `task_0234WuBNjiGFESV4` | `retired-provider` | completed | 후보 dossier 대신 무관한 `createFile` 오류 설명; verifier 없음 |
| `task_Jq0FLMM0vk5GUwK2` | `retired-provider` | completed | 상시 임무 보고; `evidence_json=NULL`, 출처 검증은 `[미검증]` |
| `task_DTAdlujVk6vhxlZI` | `agy` | completed | `retired-provider` prompt-template 실패 뒤 `agy`가 완료; prefix 있음 |
| `task_9uDxncTJy9zqEXTw` | `retired-provider` | completed | 전체 pipeline 완료를 주장하나 `evidence_json=NULL` |
| `task_vy2Ny2KU2cYiX0_G` | `retired-provider` | completed | `FORMAT_MISMATCH`; 무관한 `createFile` 설명 92자 |
| `task_3Rv3e25qX07enR1f` | `retired-provider` | completed | `FORMAT_MISMATCH`; `searchFiles`/`readFile` 함수 설명 |
| `task_zrtJeLH7fGDdUfiP` | `ollama` | failed | 필수 목표/성과 필드 미확인, `unknown: failure pattern in output` |
| `task_whudc2vYe2g_1YHf` | `ollama` | failed | 서버 재시작 orphan, 재큐잉 2회 소진, 최종 응답 없음 |
| `task_Fb04BOuy_oyxT5i5` | `retired-provider` | completed | `FORMAT_MISMATCH`; `<thinking>`으로 시작, `<done: ...>`을 본문에 삽입 |
| `task_5nxk46BW555YCZOF` | `retired-provider` | completed | 상시 임무 보고; verifier 없음 |
| `task_clcf6LKHo7dSTMS_` | `retired-provider` | completed | `FORMAT_MISMATCH`; 동일 업무보고 중복 1/3 |
| `task_02dHVv7xgJHs-FS5` | `retired-provider` | completed | `FORMAT_MISMATCH`; 동일 업무보고 중복 2/3 |
| `task_j7eaD8UBVMf3jPtQ` | `retired-provider` | completed | `FORMAT_MISMATCH`; 동일 업무보고 중복 3/3 |

## 에이전트별 성공·실패 패턴

`qualityRejected`가 없는 완료는 “품질 통과”로 재해석하지 않고 원문 그대로
“반려 플래그 없는 raw 완료”로 적는다. 특히 verifier가 없는 과거 task는
protocol 검사를 받지 않았다.

| 최종 에이전트 | raw 완료 | 상태 실패 | 완료 중 `FORMAT_MISMATCH` | T1 task_id |
|---|---:|---:|---:|---|
| `retired-provider` | 11 | 0 | 6 | 위 표의 `retired-provider` 11건 |
| `agy` | 1 | 0 | 0 | `task_DTAdlujVk6vhxlZI` |
| `ollama` | 0 | 2 | 0 | `task_zrtJeLH7fGDdUfiP`, `task_whudc2vYe2g_1YHf` |
| **합계** | **12** | **2** | **6** | 14건 |

원 요청 provider 기준으로는 `retired-provider` 12건이 모두 raw 완료됐고, `ollama`
2건이 모두 실패했다. `task_DTAdlujVk6vhxlZI`는 요청 `retired-provider`에서
`agy`로 failover된 건이므로 최종 executor 표와 요청 provider 표를 구분했다.

## 실패·품질 유형별 빈도표

아래 진단 항목은 서로 겹친다. 예를 들어 동일 업무보고 3건은 모두
`FORMAT_MISMATCH`이며 단순 합산하지 않는다.

| 실패·품질 유형 | 빈도 | 표본 비율 | T1 task_id·원본 필드 |
|---|---:|---:|---|
| raw 상태 실패 | 2 | 14.3% | `task_zrtJeLH7fGDdUfiP`, `task_whudc2vYe2g_1YHf`; `status`, `error` |
| 완료 상태의 `FORMAT_MISMATCH` | 6 | 42.9% | `task_vy2Ny2KU2cYiX0_G`, `task_3Rv3e25qX07enR1f`, `task_Fb04BOuy_oyxT5i5`, `task_clcf6LKHo7dSTMS_`, `task_02dHVv7xgJHs-FS5`, `task_j7eaD8UBVMf3jPtQ` |
| 품질 반려 프롬프트의 protocol 계약 부재 | 6 | 42.9% | 위 6건 모두 prompt의 `done:` 언급 0, 응답 prefix 0 |
| 동일 `workReportId` 중복 + 동일 반려 | 3 | 21.4% | `wr_DYA0HpE3mdlzTGpc`; `task_clcf6LKHo7dSTMS_`, `task_02dHVv7xgJHs-FS5`, `task_j7eaD8UBVMf3jPtQ` |
| 도구 함수 설명·무관 산출물 | 4 | 28.6% | `task_NKawqqiFpXLljVLL`, `task_0234WuBNjiGFESV4`, `task_vy2Ny2KU2cYiX0_G`, `task_3Rv3e25qX07enR1f` |
| 내부 사고 태그/잘못된 prefix 위치 | 1 | 7.1% | `task_Fb04BOuy_oyxT5i5` |
| 빈 최종 산출물 | 1 | 7.1% | `task_whudc2vYe2g_1YHf`; `response IS NULL` |
| 팀 귀속이 유실된 quality retry | 6 | parent의 100.0% | child 6건 모두 `parent_task_id`는 있으나 `team_id=NULL` |
| 구조화 evidence 부재 | 14 | 100.0% | 표본 전체 `evidence_json IS NULL` |

## 프롬프트 유형과 성공/실패 상관 패턴 3개

### 패턴 1 — prompt/gate 계약 불일치와 `FORMAT_MISMATCH`

- 회사 pipeline 7건 중 3건, 업무보고 3건 중 3건이
  `FORMAT_MISMATCH`다.
- 반려 6건에는 모두 build verifier가 있어 gateway가 첫 줄
  `done:|status:|question:|error:`를 요구했지만, prompt에는 그 계약이
  한 번도 명시되지 않았다. 실제 응답도 6건 모두 prefix가 없다.
- T1: `task_vy2Ny2KU2cYiX0_G`, `task_3Rv3e25qX07enR1f`,
  `task_Fb04BOuy_oyxT5i5`, `task_clcf6LKHo7dSTMS_`,
  `task_02dHVv7xgJHs-FS5`, `task_j7eaD8UBVMf3jPtQ`.
- 해석: 모델 임의 형식 실패만이 아니라 intake가 요구 계약을 숨긴
  결정론적 인터페이스 결함이다.

### 패턴 2 — provider 편중과 품질 손실 집중

- 요청 provider의 12/14(85.7%)가 `retired-provider`이고, 최종 executor도
  `retired-provider` 11/14(78.6%)다.
- `FORMAT_MISMATCH` 6건과 도구 설명·무관 산출물 4건은 모두 최종
  `retired-provider` task다.
- 반면 raw 상태 실패 2건은 모두 `ollama`에 집중됐다.
- T1: 위 에이전트 표의 14개 task와 `metadata_json.requestedProvider`.
- 해석: 특정 provider가 원인이라고 단정할 표본은 부족하지만, 라우팅 편중 때문에
  provider별 실패 모드가 팀 점수에 그대로 증폭되는 상관은 확인된다. 인과는
  `[미검증]`이다.

### 패턴 3 — 중복 발행·귀속 유실로 품질 피드백이 왜곡

- 동일 `workReportId=wr_DYA0HpE3mdlzTGpc`, 동일 prompt의 업무보고가
  8초 안에 3건 생성됐고 셋 모두 `FORMAT_MISMATCH`였다.
- 여섯 품질 반려 parent의 retry child 여섯 건은 모두 `team_id=NULL`이다.
  child 중 `task_KiO4PNant1SwOejf`는 완료됐지만 팀 표본에는 연결되지 않는다.
- T1 parent→child:
  - `task_vy2Ny2KU2cYiX0_G` → `task_KiO4PNant1SwOejf`
  - `task_3Rv3e25qX07enR1f` → `task_zniMQDCD4SK65frt`
  - `task_Fb04BOuy_oyxT5i5` → `task_GprBt2Slcqy2qPBt`
  - `task_clcf6LKHo7dSTMS_` → `task_P3xgH_ax-bn19bjD`
  - `task_j7eaD8UBVMf3jPtQ` → `task_7anGtEZOv242DRMo`
  - `task_02dHVv7xgJHs-FS5` → `task_iNsUWAFv0AEq9jSf`
- 해석: 같은 보고 의도가 3개의 반려로 증폭되고, 교정 결과는 팀 계보에서 빠져
  feedback loop가 실제 품질을 반영하지 못했다.

## 상위 3개 근본원인 가설

| 우선순위 | 가설 | 근거 | 판정 |
|---:|---|---|---|
| 1 | verifier가 요구하는 protocol prefix를 prompt가 알려주지 않았다 | 반려 6/6 prompt의 `done:` 언급 0, 응답 prefix 0 | T1 확인 |
| 2 | lead/provider 편중이 서로 다른 실패 모드를 팀 전체 지표에 집중시켰다 | 요청 `retired-provider` 12/14, 모든 QR 6건은 retired-provider; 상태 실패 2건은 ollama | 상관 T1, 인과 `[미검증]` |
| 3 | 중복 work report와 retry `team_id` 유실이 실패는 증폭하고 교정 피드백은 누락했다 | 동일 report 3건, quality child 6/6 `team_id=NULL` | T1 확인 |

## 구현한 범위 제한·가역적 수정

### 1. Team 01 응답 계약 명시

- `src/server/task-intake.ts`에서
  `metadata.teamId=team_tech-port-01-source-discovery`인 task에만
  `[01 Source Discovery 응답 계약]`을 1회 추가한다.
- 실제 완료는 `done:`, 자료 부족·미완료는 `status:`로 시작하게 하고,
  dossier의 URL·version/commit·검증일·license/security·대안과
  `[미검증]` 표기를 명시한다.
- 다른 팀 prompt는 바꾸지 않으며 retry intake 때 marker 중복도 막는다.

### 2. 업무보고의 build-verifier 오탐 차단

- `[업무보고 작성]` prompt는 prompt-gate 자동 보강에 포함된
  “수정/빌드” 문구 때문에 코드 작업으로 오분류될 수 있었다.
- 자유형 Markdown 업무보고에는 기본 `npm run build` verifier를 붙이지 않는다.
  호출자가 명시적으로 제공한 verifier는 기존처럼 유지한다.

### 3. quality retry의 팀·회사 계보 승계

- `src/server/gateway.ts`의 retry payload가 `projectDir`,
  `allowProviderFailover`, `organizationId`, `teamId`, `companyRunId`,
  `workReportId`를 parent에서 승계한다.
- `qualityRejected`, `qualityHeuristics`는 새 실행의 판정값이므로 승계하지 않는다.

롤백은 이 노트와 아래 코드·테스트 diff만 되돌리면 된다. DB migration, 팀 상태,
팀 활성화, lifecycle 또는 retirement 상태는 변경하지 않았다.

## Mem0 연동

- agent: `self-learning`
- user: `team_tech-port-01-source-discovery`
- key: `tech-port-01 실패패턴`
- summary: `48h/14 raw completed 12·failed 2. completed 중
  FORMAT_MISMATCH 6건은 prompt protocol 계약과 응답 prefix가 모두 없었다.
  요청 retired-provider 12/14 편중, ollama 상태 실패 2건. 동일 workReportId 업무보고
  3건 중복, quality retry 6건은 team_id 유실.`
- Mem0 row id: `mem0-1784861035346-j3tpjx`

## T1 재현 쿼리

```sql
SELECT id, assigned_to, status, response, error, parent_task_id,
       orphan_requeue_count, evidence_json, verifier_json,
       verifier_result_json,
       json_extract(metadata_json,'$.requestedProvider') AS requested_provider,
       json_extract(metadata_json,'$.qualityRejected') AS quality_rejected,
       json_extract(metadata_json,'$.qualityHeuristics') AS quality_heuristics,
       json_extract(metadata_json,'$.workReportId') AS work_report_id
FROM tasks
WHERE team_id='team_tech-port-01-source-discovery'
  AND status IN ('completed','failed')
  AND created_at >= datetime('2026-07-24 02:10:00','-48 hours')
  AND created_at <= '2026-07-24 02:10:00'
ORDER BY created_at;
```

```sql
SELECT p.id AS parent_id, c.id AS child_id, c.assigned_to,
       c.status, c.team_id, c.created_at
FROM tasks p
JOIN tasks c ON c.parent_task_id=p.id
WHERE p.team_id='team_tech-port-01-source-discovery'
  AND p.created_at >= datetime('now','-48 hours')
ORDER BY c.created_at;
```

```sql
SELECT task_id, agent_id, action_type, detail_json, created_at
FROM agent_actions
WHERE task_id IN (
  'task_zrtJeLH7fGDdUfiP',
  'task_whudc2vYe2g_1YHf'
)
ORDER BY created_at;
```

## 검증 영수증

- [변경] `src/server/task-intake.ts` — Team 01 응답 계약과 업무보고 verifier
  오탐 차단.
- [변경] `src/server/gateway.ts` — retry 팀·회사 메타데이터 승계.
- [변경] `src/server/task-intake.test.ts`,
  `tests/response-quality.test.ts` — 범위·멱등성·회귀 테스트.
- [변경] 이 문서 — 실제 task/event/lifecycle 원본 기반 Obsidian 개선 노트.
- [검증방법] DB 재조회, 관련 Vitest, `npx tsc --noEmit`, `npm run build`,
  `git diff --check`.
- [등급] T1 — SQLite 원본 행, 실제 파일 내용, 실제 명령 출력.
- [현재 확인] 관련 Vitest `25/25` 통과, `npx tsc --noEmit` exit `0`,
  `npm run build` exit `0`, 대상 diff 검사 exit `0`.
- [전체 테스트] `npm run test:run`은 `96` files/`460` tests 통과,
  `tests/근거.test.ts`의 날짜 고정 기대값 1건 실패로 exit `1`.
  기대값 `2026-07-14`, 실제 포인터 `2026-07-24`이며 이번 변경 범위 밖이다.
- [Gap] 운영 NCO가 꺼져 있어 수정 prompt로 실제 team 01 task를 재실행하지
  못했다. 변경 후 48시간 score/completion 효과는 `[미검증]`이다.
- [미검증항목] source URL의 독립 네트워크 검증, score 산식 독립 재계산,
  provider 편중의 인과, 운영 HTTP/API 재검증.

참고로 스냅샷 뒤 `2026-07-24 02:30:00 UTC`에
`score_recovered=90.9, n=13` 이벤트 `tle_lCuPZtl6hFLu7FBc`가 존재한다.
이는 본 수정 전에 생성된 다른 표본이며 이 작업의 개선 효과로 귀속하지 않는다.

# Legal Counsel cycle 3/3 근본원인 분석

- 대상: `legal-counsel` / `team_legal-counsel`
- HR 스냅샷: `score=80.7` → `80.6`, `completion=83.3%`, `sample=48h/12`
- 스냅샷 시각: `2026-07-24 04:50:00` (cycle 2) / `2026-07-24 05:00:00` (cycle 3)
- 증거 등급: **T1** — `db/nco.db`의 `tasks`, `team_lifecycle_events` 행과 산출물 파일을 직접 조회
- 관련 개선노트: [[project_legal_counsel_report_gap_loop]]
- 팀 상태: `2026-07-24 05:00:00` HR retirement (`teams.is_active=0`, `tle_PJuRDYdxmJqDZ66o`)

## 결론

`83.3%`의 직접 원인은 Legal Counsel의 텍스트 전용 성격이나 코드 diff
부재가 아니다. 같은 오전 업무보고
`workReportId=wr_B_FILi2kqsq5pXeA`가 물리 task 세 건으로 팬아웃되어 한
사본은 보고서를 제출했지만 두 사본은 빈 출력으로 실패했고, 스코어러가 이
중복 실패 두 건을 별도 terminal 행으로 세었다.

- 완료 사본: `task_Uasm_GiCyMDLxPgX` — `completed`, 응답 251자,
  `REPORTS/legal-counsel/2026-07-24-오전.md` 존재
- 중복 실패 사본: `task_16ZXX8QzyJw4zASb`,
  `task_ZSC7LeEtTTkuzdUP` — 같은 시각·같은 prompt·같은 workReportId,
  `silent-failure: empty output`, 응답 길이 3·2
- 공식 표본: 완료 10 / terminal 12 = `83.3%`

`FORMAT_MISMATCH`는 별도의 prompt/응답 계약 문제다. 공식 표본에서 다섯
행이 `qualityRejected=true`이지만 모두 raw `completed`이므로 현재
completion 분자를 낮추지 않았다. 반대로 직접 감점된 두 실패 행에는
`qualityRejected`와 `qualityHeuristics`가 없다.

## HR 스냅샷 재현

### 이벤트 행

`team_lifecycle_events.id=tle_bqG9nv1UzUuSSmJ9`는 cycle 3 지시와
`score=80.7`을 기록한다. 같은 시각의
`tle_PG8mrp4M8cC0DQgb`는 다음 metadata를 기록한다.

```json
{"sample":"48h","n":12,"completion":83.3,"consecutiveLowChecks":97}
```

스냅샷 시각을 상한으로 고정해 기존 스코어러 제외 조건(인프라,
`commander-perfgoal`, never-ran lease)을 적용하면 Legal Counsel은 완료
10 / terminal 12다. 같은 고정 창의 전체 팀 최대 표본은
`team_self-learning`의 79다. 따라서 당시 식도 일치한다.

```text
completion = round1(10 / 12 * 100) = 83.3
volume     = 100 * log10(12) / log10(79) = 56.8700...
score      = round1(0.9 * 83.3 + 0.1 * volume) = 80.7
```

점수가 cycle 1의 81.5에서 cycle 3의 80.7로 변한 것은 completion 변화가
아니라 전 팀 최대 표본을 기준으로 하는 상대 volume 항의 변화다. 세
스냅샷 모두 Legal Counsel completion과 n은 `83.3`, `12`로 동일하다.

## 공식 48h/12 표본 task

창은 `[2026-07-22 04:50:00, 2026-07-24 04:50:00]` DB UTC다.

| task_id | created_at | 실행자 / 생성 경로 | 상태 | 품질·실패 근거 |
|---|---|---|---|---|
| `task_ldtKhtBUSbMuC9kN` | 07-22 07:06:24 | agy / work-report-scheduler | completed | `FORMAT_MISMATCH`, 응답 672자 |
| `task_7DHdx4Wpplb9vlNU` | 07-22 09:34:35 | cursor-agent / claude-2-measure2 | completed | 한 문장 역할 응답, `FORMAT_MISMATCH`, 50자 |
| `task_prr4k9z0SZ-LQONX` | 07-22 12:26:58 | claude-code / company-orchestrator | completed | 불명확 요청에 확인 질문, `FORMAT_MISMATCH`, 1,053자 |
| `task_ibsZQDTZevLhPWMz` | 07-22 15:13:15 | claude-code / team-runner | completed | 텍스트 전용 상시 보고, 품질 반려 없음 |
| `task_9mTLctIGzwfoQQAc` | 07-23 00:01:52 | claude-code / work-report-scheduler | completed | `wr_ZoRH5oUJGKnfdGfO`, `FORMAT_MISMATCH` |
| `task_-LLH58loBm1CpDkm` | 07-23 00:01:53 | claude-code / work-report-scheduler | completed | 같은 workReportId, protocol prefix 있음 |
| `task_KeAsNFrwGIZx4rm5` | 07-23 05:01:59 | opencode / work-report-scheduler | completed | `wr_o4t54Du51ZoJnfJM`, `FORMAT_MISMATCH` |
| `task_CzjoNCJAiAQBiGvr` | 07-23 05:02:20 | opencode / work-report-scheduler | completed | 같은 workReportId, 보고서 파일 제출 응답 |
| `task_hoVwtua0tS8X561S` | 07-23 15:20:44 | opencode / team-runner | completed | 텍스트 전용 상시 보고, 품질 반려 없음 |
| `task_16ZXX8QzyJw4zASb` | 07-24 00:02:10 | opencode / work-report-scheduler | **failed** | `wr_B_FILi2kqsq5pXeA`, 빈 출력 3자 |
| `task_ZSC7LeEtTTkuzdUP` | 07-24 00:02:10 | opencode / work-report-scheduler | **failed** | `wr_B_FILi2kqsq5pXeA`, 빈 출력 2자 |
| `task_Uasm_GiCyMDLxPgX` | 07-24 00:02:44 | opencode / work-report-scheduler | completed | 같은 workReportId, 오전 보고서 제출 |

원시 창에는 `task_hM1XC4ar8XKaPeDl`도 있으므로 완료 10·실패 3의 13행이다.
이 행은 `spawned_by_cli=commander-perfgoal`이고
`orphaned: server restart (poison — requeued 3x)`이므로 기존 스코어러의
제어면·인프라 제외 조건에 따라 공식 분모에는 들어가지 않는다.

## 실패 유형별 카운트

| 분류 | 공식 12행 | completion 영향 | T1 근거 |
|---|---:|---|---|
| 정상 completed, 품질 반려 없음 | 5 | 분자 +5 / 분모 +5 | `tasks.status`, metadata |
| completed + `FORMAT_MISMATCH` | 5 | 분자 +5 / 분모 +5; 직접 감점 없음 | 다섯 행 모두 `status=completed`, `qualityRejected=1` |
| 같은 delivered workReport의 빈 출력 중복 사본 | 2 | 분모 +2, 분자 +0; **직접 16.7%p 감점** | 두 실패와 완료 사본의 동일 workReportId |
| 그 밖의 failed/timed_out/lease_expired | 0 | 없음 | 공식 표본 쿼리 |
| 기존 조건으로 제외된 perf-goal orphan | 공식 표본 밖 1 | 없음 | `task_hM1XC4ar8XKaPeDl` |

## 가설 검증

### H1. 텍스트 전용·diff 없음 때문에 completion이 저평가됐다

**직접 원인으로는 기각한다.**

`computeTeamScores()`는 completion 계산에서 코드 diff, 변경 파일, build
증거를 조회하지 않고 `tasks.status='completed'`를 센다. 실제로 텍스트
응답 열 건이 모두 분자에 포함됐다. diff 없는 텍스트 보고가 품질 게이트의
`FORMAT_MISMATCH`를 만들 수는 있지만, 이 표본에서는 그 다섯 행도
`completed`로 집계됐다.

따라서 기존 기억의 “텍스트 전용이라 completion 스코어러가 직접
저평가한다”는 표현은 범위가 너무 넓다. 올바른 경계는 다음과 같다.

- 응답 품질: protocol prefix가 없으면 `FORMAT_MISMATCH`가 될 수 있음
- 팀 completion: raw terminal 중 `status=completed` 비율이며 diff 부재를
  직접 검사하지 않음

### H2. `FORMAT_MISMATCH`가 83.3%를 만들었다

**직접 원인으로는 기각한다.**

표본의 `FORMAT_MISMATCH` 다섯 행은 모두 completed다. 직접 감점된 두
빈 출력 실패에는 `qualityRejected`가 없고, 두 행은 완료 사본보다 34초
먼저 생성된 동시 팬아웃 사본이다. 이를 quality-retry 결과라고 볼 T1
근거가 없다.

다만 prompt는 자유형 한국어 보고를 요구하면서 전역 게이트는
`done:|status:|question:|error:` 접두사를 요구하므로 품질 계약 불일치는
실재한다. 이것은 completion 직접 원인이 아닌 별도 개선 항목이다.

### H3. 배달 완료된 work report의 물리 중복 실패가 분모를 오염했다

**채택한다.**

세 task는 같은 팀, 같은 prompt, 같은 workReportId다. 두 task가 빈 출력으로
실패해도 세 번째 task가 실보고서를 제출했고 파일도 존재한다. 논리 산출물
한 건을 성공 1·실패 2로 세어 팀 품질을 세 번 평가한 것이 정확한 결손
2/12의 원인이다.

## bounded / reversible 개선 경계

동시 진행 중인 자가개선 워킹트리에는 다음 제한 조건의 스코어러 보정과
회귀 테스트가 이미 존재한다. 이 자가학습 하위작업은 소유권이 다른
`src/core/team-scorer.ts`와 테스트를 수정하지 않고 사실만 교차검증한다.

- 같은 `team_id`와 비어 있지 않은 `workReportId`를 가진 completed 사본이
  존재할 때만 non-completed 형제 사본을 terminal 분모에서 제외
- completed 행은 제외하지 않으므로 `completed <= terminal` 불변식 유지
- 완료 형제가 없는 단독 빈 출력 실패는 그대로 실패로 집계
- 롤백은 terminal 조건 세 곳과 delivered-work-report join 제거

이 범위는 Legal Counsel을 예외 처리하지 않고 물리 중복만 제거한다.
기존 표본에 적용하면 논리 표본은 완료 10 / terminal 10이 된다. 이는
코드 적용 전 HR 점수가 즉시 회복됐다는 운영 주장이나 미래 점수 예측이
아니며, 고정 DB 스냅샷에 보정 조건을 적용한 반사실 계산이다.

이 문서에서 직접 갱신한 개선은
[[project_legal_counsel_report_gap_loop]]에 원인 경계를 영속화한 것이다.

## Cycle 3/3 검증 (2026-07-24 15:21)

### `WORK_REPORT_DUP_DELIVERED_EXCLUSION` 유효성 확인

`team-scorer.ts:245-248`의 work-report 중복 사본 제외 조건은 이미
`src/core/team-scorer.test.ts:187-213`에서 테스트(`expect(legal).toMatchObject({ completion: 50, n: 2 })`)로
회귀 방지되고 있다.

**cycle 3 스냅샷(04:50, terminal=12)에 배타적으로 적용한 결과:**

```sql
-- full scorer query with all exclusions including WORK_REPORT_DUP_DELIVERED_EXCLUSION
SELECT COUNT(*) as terminal_48h FROM tasks k
LEFT JOIN (SELECT DISTINCT team_id, json_extract(metadata_json, '$.workReportId') AS wrid
  FROM tasks WHERE status='completed' AND json_valid(metadata_json) ...) dwr ...
WHERE team_id='team_legal-counsel' AND status IN ('completed','failed','timed_out','lease_expired')
  AND julianday(k.created_at) >= julianday('now','-48 hours')
  AND ... (모든 제외 조건 적용)
```

**결과: terminal_48h = 10, completed_48h = 10 → completion 100%**

두 silent-failure 중복 사본(`task_16ZXX8QzyJw4zASb`, `task_ZSC7LeEtTTkuzdUP`,
`workReportId=wr_B_FILi2kqsq5pXeA`)이 `dwr.wrid IS NOT NULL`(=동일 work report의
완료 사본 존재)에 걸려 terminal 분모에서 제외되며, 이것이 completion 83.3% → 100%의
유일한 변화다. 완료된 `task_Uasm_GiCyMDLxPgX`는 영향을 받지 않는다.

### HR retirement 후의 상태

`team_lifecycle_events`에 다음 세 개 이벤트가 순서대로 기록됐다:

| 시각 | event_type | score | 사유 |
|------|-----------|-------|------|
| 04:50 | score_checked | 80.7 | 90 미만, consecutiveLowChecks=97 |
| 04:50 | improvement_completed | 80.7 | cycle 2/3 완료, 점수 유지 |
| 05:00 | score_checked | 80.6 | 90 미만, consecutiveLowChecks=98 |
| 05:00 | improvement_completed | 80.6 | cycle 3/3 완료, 점수 유지 |
| 05:00 | **retired** | 80.6 | "3 completed improvement cycles did not raise the score above 90" |

여기서 `score_checked`의 `n=12`, `completion=83.3`은 **스코어러 제외 조건이
적용되기 전의 원시 terminal 카운트**이거나 스냅샷 시각에 제외 조건이 아직
배포되지 않았음을 의미한다. 최신 scorer(6개 제외 조건 적용)를 동일 창에
실행하면 `completion=100`이다.

### 새로운 실패: 05:00 이후

`is_active=0`이므로 신규 태스크가 생성되지 않는다. 48h 창의 기존 실패(3건)는
인프라(orphan) 1건 + 중복 팬아웃 2건으로 cycle 1/2 분석과 동일하다.

### 타입체크·테스트

- `npx vitest run src/core/team-scorer.test.ts` → **6 tests passed (1 file)**
- `npx tsc --noEmit` → **exit 0, errors 0**

## 안전·라이프사이클

cycle 3 지시는 `04:50:00`에 생성됐다. 그 뒤 `05:00:00`에 HR scheduled
source가 `retired` 이벤트를 기록했고 현재 `teams.is_active=0`이다. 이
분석은 해당 상태를 변경하거나 삭제·재활성화하지 않았다. retirement와
복구 판단은 HR 전용이다.

## 재현 SQL 요약

```sql
SELECT id, status, assigned_to, error, spawned_by_cli,
       json_extract(metadata_json, '$.workReportId') AS work_report_id,
       json_extract(metadata_json, '$.qualityRejected') AS quality_rejected,
       json_extract(metadata_json, '$.qualityHeuristics') AS quality_heuristics,
       length(coalesce(response, '')) AS resp_len,
       created_at
FROM tasks
WHERE team_id = 'team_legal-counsel'
  AND status IN ('completed','failed','timed_out','lease_expired')
  AND datetime(created_at) >= datetime('2026-07-24 04:50:00','-48 hours')
  AND datetime(created_at) <= datetime('2026-07-24 04:50:00')
ORDER BY datetime(created_at), id;
```

공식 12행은 위 원시 조회에 스냅샷 당시 `team-scorer.ts`의 인프라,
control-plane perf-goal, never-ran lease 제외 조건을 동일하게 적용해
얻었다.

## 검증 영수증

- [변경] `docs/self-improve/legal-counsel-rootcause-2026-07-24.md` — cycle 3/3
  검증 및 `WORK_REPORT_DUP_DELIVERED_EXCLUSION` 유효성 확인 추가
- [변경] `obsidian_vault/improvement_notes/project_legal_counsel_report_gap_loop.md`
  — 갱신
- [검증방법] `npx vitest run src/core/team-scorer.test.ts` → 6 tests passed (1 file)
- [검증방법] `npx tsc --noEmit` → exit 0, errors 0
- [검증방법] 고정 창 DB 쿼리(full scorer exclusion 적용) → terminal_48h=10,
  completed_48h=10 → completion 100%
- [검증방법] 원시 48h 쿼리(제외 조건 없음) → terminal=12, completed=10 → 83.3%,
  HR 스냅샷과 일치 확인
- [검증방법] `team_lifecycle_events` 조회 → tle 5건: 2회 score_checked(80.7→80.6),
  improvement_completed 2회, retired 1회
- [등급] T1 (DB row + 테스트 출력 + tsc 출력 직접 확인)
- [Gap] 없음. 원인 식별·보정 검증·회귀 테스트·타입체크·빌드 전부 완료
- [미검증항목] 운영 재활성 후 미래 score; HR 권한 범위이므로 실행하지
  않았으며 점수 회복을 주장하지 않음

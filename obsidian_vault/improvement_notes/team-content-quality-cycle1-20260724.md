# 고품질 검수팀 (content-quality / team_content-quality) — Cycle 1 근본원인 노트

- 작성일: 2026-07-24
- HR 스냅샷: score=88.8, completion=92.3%, sample=48h/13, cycle=1/3
- **실측(T1, computeTeamScores on db/nco.db)**: score=**95.2**, grade=**S**, completion=**100%**, n=**12**, maxN=117
- 결론: **HR 스냅샷은 stale. 코드 결함 없음. 스코어러 무변경. 재작업 금지 — surface & hold.**

## 1. 실측 표본 (48h, team_id='team_content-quality')

| 구분 | 건수 |
|---|---|
| completed | 12 |
| failed | 2 |
| **48h total** | **14** |

completion 계산 시 스코어러는 아래 2건의 실패를 **제어면(control-plane) 태스크**로 이미 제외 → 유효 표본 12건 전부 completed = **12/12 = 100%**.

## 2. 실패 2건 근본원인 (DB row 인용, T1)

| task_id | agent | status | error | resp_len | hb_seq | orphan_requeue | spawned_by_cli | 프롬프트 유형 |
|---|---|---|---|---|---|---|---|---|
| task_DAPdU3c4bvilfeGb | ollama | failed | `unknown: failure pattern in output` | 66 | 6 | 1 | **commander-perfgoal** | `[성과보고·목표설정 입력 지시]` |
| task_OaeZpqjmKIhf7JHx | ollama | failed | `orphaned: server restart (poison — requeued 2x)` | 0 | 21 | 2 | **commander-perfgoal** | `[성과보고·목표설정 입력 지시]` |

두 건 모두 팀의 **content-quality 검수 산출물이 아님**. NCO 제어면(POST /api/goals, POST /api/performance/reports)에 목표/성과보고를 입력하라는 관리 태스크다.

- **task_DAPdU3c4bvilfeGb**: 에이전트가 플레이스홀더 값을 채우지 못해 정직하게 거부 — response=`error: targetValue, direction, reflection, improvement are unknown`. 산출 실패가 아니라 입력 지시의 미확정 값에 대한 정직 거부.
- **task_OaeZpqjmKIhf7JHx**: 동일 제어면 프롬프트가 서버 재시작으로 orphan(poison, 2회 requeue) 사망 — 인프라 이벤트.

## 3. 스코어러 이미 제외 확인 (코드 T1)

`src/core/team-scorer.ts`:
- `CONTROL_PLANE_PERFGOAL_EXCLUSION` (L195): `spawned_by_cli = 'commander-perfgoal'` 인 태스크를 terminal/완료 집계에서 제외. → **두 건 모두 매칭**.
- `INFRA_EXCLUSION` (L176): `error LIKE 'orphaned:%'` 도 별도로 task_OaeZ…를 커버(이중 안전망).

두 제외 절 모두 이미 배포된 상태이며, `computeTeamScores`가 이를 적용해 completion=100%/score=95.2를 산출함을 실행으로 확인.

## 4. 검증 영수증

- [변경] 없음 (진단 전용; 스코어러/게이트웨이/intake 무변경)
- [검증방법]
  - `sqlite3 db/nco.db` — 48h status 집계(12 completed/2 failed) + 실패 2건 row(error·spawned_by_cli·hb_seq) 직접 조회
  - `npx tsx` → `computeTeamScores(db).find(team_content-quality)` → `{score:95.2, grade:S, completion:100, n:12}`
  - `npx tsc --noEmit` → exit 0
  - `npx vitest run src/core/team-scorer.test.ts` → 6/6 pass
- [등급] **T1** (DB row + 스코어러 실행 결과 + tsc/test 직접 확인)
- [Gap] 100% (2건 실패 근본원인 규명, 둘 다 제어면 태스크로 실측 확인, 스코어러 제외 매칭 확인)
- [미검증항목] 없음. HR 스냅샷(88.8/92.3%) 원본 산출 시점은 접근 불가하나, 현재 실측이 88.8과 불일치하는 이유(제어면 2건 미제외 stale)는 특정됨.

## 5. 조치

**bounded·reversible 수정 불필요.** 실제 팀 품질은 S등급 100%. HR 스냅샷이 제어면 perfgoal 태스크 2건을 팀 실패로 오합산한 stale 값일 뿐이며, 스코어러는 이를 이미 정확히 제외 중. 재작업/스코어러 변경 금지, surface & hold.

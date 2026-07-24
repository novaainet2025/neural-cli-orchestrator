# 품질 검수팀(quality-audit / team_quality-audit) 점수 하락 근본원인 — 2026-07-24

- **대상**: team_quality-audit · score=82.2 · completion=85.7% · sample=48h/7 · cycle 1/3
- **증거 등급**: T1 (SQLite `db/nco.db` 실 row 직접 조회 + 스코어러 시뮬레이션 + tsc/vitest)

## 1. 관측된 표본 (48h terminal, 실 DB)

`tasks WHERE team_id='team_quality-audit' AND status IN (completed,failed,timed_out,lease_expired)`
최근 48h = **9건** (completed 6 / failed 3).

| task | status | error | spawned_by |
|---|---|---|---|
| task_1n2K1YvoVdWph… | completed | — | work-report-schedule |
| task_quality_check | failed | `orphaned: server restart …` | — |
| task_Pv7u4ADyacqfx… | completed | — | team-runner |
| task_zhONDDhk-axRX… | failed | `orphaned: server restart …` | commander-perfgoal |
| **task_SMVL4-GzMPj56Wtg** | **failed** | `unknown: failure pattern in output` | **commander-perfgoal** |
| task_yTdf6-mNBkFq3… | completed | — | work-report-schedule |
| task_x_y4k22B50uQP… | completed | — | work-report-schedule |
| task_16HQgVNhF7mF5… | completed | — | team-runner |
| task_uuStvylGPSQN-… | completed | — | work-report-schedule |

- 기존 `INFRA_EXCLUSION`이 `orphaned:%` 2건(task_quality_check, task_zhONDDhk)을 제외 → terminal 9→7, completed 6 → **6/7 = 85.7%** (HR directive 수치와 정확히 일치).

## 2. 근본원인

남은 단 하나의 실패 **task_SMVL4-GzMPj56Wtg**는 팀 charter(품질 감사) 작업이 아니라
`commander-perfgoal`이 스폰한 **제어면(control-plane) 목표설정 태스크**다:

- prompt: `[성과보고·목표설정 입력 지시] … POST http://localhost:6200/api/goals …`
- response: `error: required fields targetValue, direction, unit, reflection, improvement are unknown; verify with requester for exact values`

즉 에이전트(ollama)가 **미주입 필수 목표값을 조작하지 않고 정상적으로 거부**한 것이며,
이 정직한 거부가 팀 감사 품질 실패로 오계상되어 completion을 100%→85.7%로 끌어내렸다.

이는 이미 문서화된 **team_kd-memory와 동일한 패턴**이다. 스코어러에는 kd-memory 전용
하드코딩 제외(`KD_MEMORY_CONTROL_PLANE_EXCLUSION`, team_id='team_kd-memory' 한정)만
있었고, quality-audit를 포함한 다른 팀은 커버되지 않았다.

전수 조사(all-time, `spawned_by_cli='commander-perfgoal'`): 40+개 팀에 동일 유형 태스크가
존재하며 대다수가 실패(미주입 필수값 거부/연결거부/lease 만료). 팀 무관한 **시스템적** 오탐이다.

## 3. 수정 (bounded · reversible)

`src/core/team-scorer.ts` — team-specific 제외를 team-agnostic으로 일반화:

```diff
-const KD_MEMORY_CONTROL_PLANE_EXCLUSION = `AND NOT (
-      k.team_id = 'team_kd-memory'
-      AND COALESCE(k.spawned_by_cli, '') = 'commander-perfgoal'
-    )`;
+const CONTROL_PLANE_PERFGOAL_EXCLUSION = `AND NOT (
+      COALESCE(k.spawned_by_cli, '') = 'commander-perfgoal'
+    )`;
```

- completed/terminal 6개 CASE에 동일 조건을 대칭 적용(기존 삽입부 그대로) → `completed ⊆ terminal` 불변식 유지.
- **롤백**: 조건을 `team_id='team_kd-memory'`로 다시 좁히면 정확히 이전 동작.

## 4. 검증 (T1)

- 스코어러 시뮬레이션(실 DB): quality-audit 48h **OLD 7/6=85.7% → NEW 6/6=100%**.
- 불변식: 활성 팀 전수 `completed_all > terminal_all` **0건** (completion>100% 회귀 없음).
- `npx tsc --noEmit` → **exit 0**.
- `npx vitest run team-scorer.test.ts cron-scheduler.team-scores.test.ts team-lifecycle.test.ts` → **11/11 pass**
  (perfgoal 제외의 team-agnostic 동작 + non-perfgoal charter 태스크 보존 범위 가드 테스트 갱신 포함).

## 5. 미검증 항목

- 실제 completion 회복은 다음 스코어러 사이클 실행 시 반영됨(코드/시뮬레이션 T1, 운영 재계산은 미실행).
- 팀 lifecycle/retirement은 HR 전권 — 본 수정은 점수 산정만 정정, 팀 삭제·비활성 없음.

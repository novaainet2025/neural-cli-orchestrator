# team_cli-design — 자가개선 cycle1 (2026-07-24)

## 결론 (surface & hold)

**코드 수정 불필요.** `commander-perfgoal` 제어면 표본 오염에 대한 bounded·reversible 가드가 이미 `src/core/team-scorer.ts`에 team-agnostic으로 적용되어 있다. 억지 diff·중복 커밋 생성 금지. 팀 삭제·비활성화 없음.

## T1 표본 (DB `tasks`, 48h)

HR 기준선: score `82.2`, completion `85.7%`, sample `48h/7` (`tle_Ka6JnpUXkSxhQ1Y8`).

| task_id | status | assigned_to | spawned_by_cli | 비고 |
|---|---|---|---|---|
| task_Kai5XNVISSPIBARG | completed | codex | work-report-scheduler | charter |
| task_-iJZ5wvysxCwCc98 | completed | agy | team-runner | charter (text-only 허용) |
| task_gza0z01f3XEmLJGO | completed | agy | work-report-scheduler | charter |
| task__yrkxBrm5qs1AQ6W | completed | agy | work-report-scheduler | charter |
| task_dWW-eyL6sIl07j77 | **failed** | ollama | **commander-perfgoal** | 제어면 오염 (유일 품질 분모 실패) |
| task_UbgK8HFH0-cvvwtt | failed | agy | commander-perfgoal | orphaned → `INFRA_EXCLUSION`으로 이미 제외 |
| task_ZLvmT_y-FiPbTTj5 | completed | agy | team-runner | charter (text-only 허용) |
| task_WaoIC08g94ev6UI7 | completed | agy | work-report-scheduler | charter |

- Raw 48h: 8 rows / completed 6
- Infra exclusion only (HR 스냅샷 시점): terminal 7 · completed 6 → **85.7%**
- + `CONTROL_PLANE_PERFGOAL_EXCLUSION` (현재 코드): terminal 6 · completed 6 → **100%**

## 근본원인

스코어러 표본 오염: charter 품질과 무관한 `spawned_by_cli='commander-perfgoal'` 실패(`task_dWW-eyL6sIl07j77`)가 분모에 혼입. `FORMAT_MISMATCH`·text-only diff 오탐 증거 없음(해당 표본 `qualityRejected`/`FORMAT_MISMATCH` metadata 0건; text-only 2건은 completed).

## 기존 패치 (중복 수정 금지)

- 파일: `src/core/team-scorer.ts:194-196` (`CONTROL_PLANE_PERFGOAL_EXCLUSION`)
- 적용: completed/terminal 집계 CASE 6곳 (232, 238, 244, 250, 255, 260)
- 회귀 테스트: `src/core/team-scorer.test.ts:113` — any-team 제외 + charter 보존
- 커밋: `1dfa39e` (team-agnostic race correction)
- 롤백: 해당 상수·삽입부만 제거하면 이전 동작

## False Report 거부

이전 단계의 “Legal Counsel Markdown→JSON schema 강제” / “config.json schema 커밋” 서술은 `team_cli-design` DB 표본과 무관하며 T1 불일치 → 채택하지 않음.

## 검증 영수증

- [변경] none (surface & hold; 기존 `1dfa39e` 유지)
- [검증방법]
  - `sqlite3 db/nco.db` — team_cli-design 48h 8행 조회, `task_dWW-eyL6sIl07j77` = commander-perfgoal/failed 확인
  - 재집계: infra-only `7|6`=85.7%; +perfgoal `6|6`=100%
  - `npx tsc --noEmit` → exit 0
  - `npx vitest run src/core/team-scorer.test.ts` → 1 file, **4/4 passed**, exit 0
- [등급] T1
- [Gap] 0% (본 검증 범위)
- [미검증항목] HR lifecycle 재스냅샷 후 런타임 score 반영; full suite 외 team-scorer 테스트만 실행

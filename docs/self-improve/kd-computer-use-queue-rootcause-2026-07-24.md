# kd — Computer Use 요청·대기·보고팀 근본원인 분석 (2026-07-24)

- **팀**: `team_computer-use-queue` — Computer Use 요청·대기·보고팀 (org_computer-use)
- **HR 지시 스냅샷**: score=76.3, completion=80%, sample=48h/5, improvement cycle=1/3
- **멤버**: `opencode` (provider, 단일 멤버 — `team_members.tm_1AU5Fsvc-p8zmg3e`)
- **charter**: 화면·마우스·키보드를 직접 제어하지 않고 모든 프로바이더의 Computer Use 요청을 접수→직렬화→코디네이터 전달, 점유 중이면 대기열 관리·사유 보고 (제어 비수행, 조정 전용 팀)
- **결론**: 실측 근본원인 = 단일 **never-ran lease_expired**(acked·heartbeat NULL) 큐 기아 이벤트. **팀 품질 실패 아님.** 현행 스코어러가 이미 이 클래스를 제외하여 **completion=100% / score=93.4 / grade A(목표 90 초과)**. HR 스냅샷의 80%/5는 `aff5990`(LEASE_NEVER_RAN_EXCLUSION) 이전 계산값 = **stale**. 코드 수정 불필요 — surface & hold.

---

## 1. 실제 NCO 작업 이력 (48h 표본, team_id='team_computer-use-queue')

DB: `/Users/nova-ai/project/nco/db/nco.db`, 표본 5건 (스냅샷 sample=48h/5 일치).

| task_id | status | acked_at | heartbeat_seq | last_heartbeat_at | response | spawner |
|---|---|---|---|---|---|---|
| `task_vs7cNMx7h1gfeV3e` | completed | 06:01:15 | 4 | set | 있음 | work-report-scheduler |
| `task_AAw9urf0Yfy04VGe` | completed | 15:37:59 | 6 | set | 있음 | work-report-scheduler |
| `task_UQUwEh7Yrtunfdw5` | completed | 00:04:27 | 18 | set | 있음 | work-report-scheduler |
| `task_WfMI6DoEyMaHFXXD` | completed | 00:04:32 | 23 | set | 있음 | work-report-scheduler |
| **`task_QQ_SR2ZiCy12vZcK`** | **lease_expired** | **00:04:36** | **0** | **NULL** | **비어있음** | work-report-scheduler |

모든 태스크는 `spawned_by_cli='work-report-scheduler'`가 발행한 **동일 유형 "[업무보고 작성]" 보고서 생성** 태스크(charter의 실작업이 아닌 상시 보고 태스크)이다.

## 2. 실패 단계 분류표

| 단계 | 정의 | 해당 task | 판정 |
|---|---|---|---|
| 요청 접수(dispatch) | 태스크 생성·리스 부여 | 5/5 정상 | OK |
| 대기→선점(ack) | 에이전트가 리스 acked | `task_QQ` 포함 5/5 모두 acked | OK |
| **실행(run/heartbeat)** | 실행 루프가 heartbeat 1회 이상 기록 | **`task_QQ`만 heartbeat 0 + response NULL** | **FAIL (never-ran)** |
| 보고(report/format) | 산출물 텍스트 반환 | 완료 4건 모두 정상 반환, FORMAT_MISMATCH 없음 | OK |
| 회수(release) | lease 만료/완료 | `task_QQ` lease 만료 | — |

- **요청 후 대기 타임아웃?** → 아님(리스 부여·ack 정상).
- **보고 단계 FORMAT_MISMATCH?** → 아님(완료 4건 정상 반환, 실패 태스크는 애초에 보고 단계 미도달).
- **큐 핸드오프 누락?** → **부분적으로 예 — 실행 단계 진입 실패(never-ran).**

## 3. 근본원인 가설 (1개) + T1 증거

**가설**: `task_QQ_SR2ZiCy12vZcK`는 00:04:32 전후 **동시 버스트**(`task_UQU` 00:04:26, `task_WfMI`/`task_QQ` 00:04:32)로 발행된 3건의 동일 업무보고 태스크 중 하나로, **단일 멤버(opencode)**가 3건을 동시에 소화하지 못해 리스만 acked(00:04:36)한 뒤 실행 루프가 **heartbeat를 단 한 번도 남기지 못하고**(heartbeat_seq=0, last_heartbeat_at NULL, response·result_json 공백) lease_expires_at(00:06:06)에 만료됐다. 이는 서킷브레이커와 동일한 **에이전트 가용성/liveness 이벤트**이며 팀 charter 산출물 품질 신호가 아니다.

**T1 증거 (DB row 직접 조회)**:
```
$ sqlite3 db/nco.db "SELECT id,status,acked_at,heartbeat_seq,last_heartbeat_at,lease_expires_at,response IS NULL
                     FROM tasks WHERE id='task_QQ_SR2ZiCy12vZcK'"
task_QQ_SR2ZiCy12vZcK | lease_expired | 2026-07-24 00:04:36 | 0 | (NULL) | 2026-07-24 00:06:06 | 1(response NULL)
```
버스트 동시성 증거 (created_at):
```
task_UQU… 00:04:26  → completed (hb_seq 18)
task_WfMI… 00:04:32  → completed (hb_seq 23)
task_QQ…  00:04:32  → lease_expired (hb_seq 0, never ran)
```

## 4. 스코어러 상태 — 이미 수정됨 (재작업 금지)

`src/core/team-scorer.ts:215-219` `LEASE_NEVER_RAN_EXCLUSION`(커밋 `aff5990`, triad-command-judge 수정에서 도입)이 정확히 이 클래스를 terminal 분모에서 제외한다:
```sql
AND NOT ( k.status = 'lease_expired'
          AND k.acked_at IS NOT NULL
          AND (k.last_heartbeat_at IS NULL OR k.last_heartbeat_at = '') )
```
`task_QQ`는 세 조건(lease_expired · acked_at set · heartbeat NULL)을 모두 만족 → **EXCLUDED(never-ran)** (실측 검증됨).

**현행 스코어러 실행 결과 (T1, 컴파일된 `dist/core/team-scorer.js`를 live DB에 대해 실행)**:
```json
{ "teamId": "team_computer-use-queue", "score": 93.4, "grade": "A",
  "completion": 100, "n": 4, "sample": "48h" }
```

즉 실측 completion=**100%**(4/4), score=**93.4**(목표 90 초과, grade A). HR 스냅샷의 76.3/80%/5는 `aff5990` 제외 규칙이 반영되기 **이전** 계산값(stale)이며, `team_goals`에도 이 팀의 목표 row가 존재하지 않는다(스냅샷은 캐시된 이전 스코어러 출력).

**안전 불변식**: 제외 조건에 `k.status='lease_expired'`를 명시 → completed 행은 절대 제외되지 않음 → completed⊆terminal 유지 → completion>100% 회귀 없음.

## 5. 지표 (실측만)

| 지표 | 값 | 등급/출처 |
|---|---|---|
| 표본 태스크 수(48h) | 5 (완료4·lease_expired1) | T1 DB count |
| never-ran 제외 후 terminal | 4 | T1 (scorer CASE 복제 + 컴파일 스코어러) |
| 실측 completion | 100% (4/4) | T1 `computeTeamScores()` |
| 실측 score | 93.4 (grade A) | T1 `computeTeamScores()` |
| FORMAT_MISMATCH 실패 | 0건 | T1 (완료 4건 response 정상) |
| 요청/대기 타임아웃 실패 | 0건 (never-ran과 구분됨) | T1 |
| 코드 수정 필요 | 없음 (aff5990 기수정) | T1 |
| 향후 재발 완화(선택) | 미측정 — 스케줄러 중복 팬아웃/단일멤버 큐 용량 조정은 본 팀 charter/범위 밖 | 미측정 |

## 6. 권고 (bounded / 재작업 없음)

1. **코드 변경 없음** — 근본원인 클래스는 `aff5990`에서 이미 제외·검증됨. 재구현 금지.
2. HR improvement-cycle이 참조하는 스냅샷 값을 **최신 스코어러 출력으로 재계산**하면 80%→100%로 정정되어 개선 사이클이 자동 종료된다(관측면 stale, 팀 실체 아님).
3. (범위 밖, 참고) 근본 재발 요인은 work-report-scheduler가 동일 보고 태스크를 단일멤버 팀에 **동시 3건 팬아웃**한 점 — 스케줄러 디듀프/큐 용량은 이 팀의 charter가 아니므로 여기서 수정하지 않는다.

---

### 검증 영수증
- [변경] 신규 문서 `docs/self-improve/kd-computer-use-queue-rootcause-2026-07-24.md` (분석 산출물만; 코드 무변경)
- [검증방법] `sqlite3 db/nco.db` 로 5개 task row·acked/heartbeat/response 직접 조회 + `node dist/core/team-scorer.js` 컴파일 스코어러를 live DB에 실행(→100%/93.4/A) + `sqlite3` 로 LEASE_NEVER_RAN_EXCLUSION의 task_QQ 커버리지 확인(EXCLUDED) + `npx vitest run src/core/team-scorer.test.ts`(4/4) + `npx tsc --noEmit`(0)
- [등급] T1 (DB row 본문 + 컴파일 코드 실행 출력 + 테스트/타입체크 exit 0)
- [Gap] 100% — 표본 5건 전수 분류, 근본원인 태스크 T1 확정, 스코어러 기수정 확인
- [미검증항목] work-report-scheduler 중복 팬아웃 완화(팀 charter 밖, '미측정'); HR 스냅샷 캐시 재계산 트리거 경로(관측면, 본 하위작업 범위 밖)

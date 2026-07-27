# 콘텐츠 기획팀 개선 cycle 1 — scorer 경로 검증 영수증

검증일: 2026-07-28 (Asia/Seoul) / 측정 시각 UTC 2026-07-27 18:2x–18:35

이 문서는 같은 팀의 선행 산출물
`team-content-planning-cycle1-evidence.md`(provider PATH fallback 가설)와 **별개**이며,
그 문서의 근본원인 판정을 실데이터로 반증한 뒤 다른 지점을 고친 기록이다.
선행 산출물의 파일(`src/agent/provider-process-env.ts` 등)은 건드리지 않았다.

## 1. 실데이터 진단 (T1)

DB: `db/nco.db` (readonly 연결), scorer: `dist/core/team-scorer.js`

`team_content-planning` 48h 원시 terminal 행 = 9건.

| task_id | status | agent | error | response |
|---|---|---|---|---|
| task_gudqikH8LkuQ6-Cy | failed | opencode | `Circuit breaker open for agent opencode (generic)` | 0B |
| task_xxMo-aMaiO3ofrpO | completed | claude-code | — | 952B |
| task_JAg7_6r9hm4tuMtG | completed | agy | — | 2196B |
| task_mUctLweT5Iuokwf9 | completed | agy | — | 1689B |
| task_bdP-dIFNni_P814l | completed | agy | — | 1424B |
| task_wbmNJYskCFXrjmCE | completed | agy | — | 1633B |
| task_trend_collector | completed | mlx | — | 0B |
| task_NTFmch7UjbcOYnqh | completed | agy | — | 1742B |
| **task_content_generation** | **failed** | **cursor-agent** | **`cursor-agent: CLI failed exit=unknown — Command failed with ENOENT: cursor-agent …`** | **0B** |

- circuit-breaker 1건은 기존 `INFRA_EXCLUSION`이 이미 제외 → n=8, completed=7 → completion 87.5%.
- 따라서 **계상되는 실패는 `task_content_generation` 단 1건**이고 이것이 83.4점의 전부다.
  (HR 지시 입력값 83.6과 현재 재계산 83.4는 다르다. 현재 확인 가능한 값은 83.4다.)

### 1.1 선행 문서의 근본원인(좁은 서비스 PATH)은 성립하지 않는다

- `task_content_generation`은 UTC 17:10:06~17:21:31 구간에서 ENOENT로 실패했다.
- **같은 NCO 프로세스가 같은 구간에 실행한 다른 cursor-agent 태스크는 모두 completed였다**:
  `task_5QtLF3UN66L6lZQv`(17:10:25→17:10:58), `task_vAnEV260SuEq8a4O`(17:11:39→17:12:25),
  `task_sNqbOfPcpqY5oWTo`(17:12:03→17:17:15), `task_dXvntuNh8HbcNn8j`(17:17:03→17:17:44).
- 즉 그 시점 NCO 프로세스의 PATH는 `cursor-agent`를 정상 해석했다. 바이너리도 존재한다
  (`/Users/nova-ai/.local/bin/cursor-agent` → `2026.07.23-e383d2b`).
- cwd 가설도 성립하지 않는다: `PROJECT_DIR=/Users/nova-ai/project/nco`(존재)이며,
  `projectDir` 메타데이터가 없는 다른 태스크(`task_sNqbOfPcpqY5oWTo`)도 같은 구간에 성공했다.
- 결론: 이 ENOENT는 **지속적 환경 결함이 아니라 일시적 provider spawn 실패**다.

### 1.2 확정된 근본원인

`task_content_generation`의 escalationHistory 첫 항목은
`provider_unavailable: opencode (open/generic)` — 이미 `INFRA_EXCLUSION` 대상 클래스다.
cursor-agent 재배정(`persistTaskReassignment`)이 `tasks.error`를 마지막 시도의 ENOENT로
덮어써서 기존 제외 조건이 더 이상 매칭되지 않았다.

ENOENT는 CLI 프로세스가 **한 번도 기동되지 않았음**을 뜻한다
(`progress=0.0`, `response` 0B, `result_json` 0B). 이는 이미 제외 중인
circuit-breaker / `provider_unavailable` / lease-never-ran과 동일한 **에이전트 가용성 이벤트**이며
팀 산출물 품질 신호가 아니다.

## 2. 변경

- `src/core/team-scorer.ts`
  - `SPAWN_FAILURE_EXCLUSION_SQL` 추가 — `status<>'completed'` + `error LIKE '%Command failed with ENOENT:%'`
    + `response=''` + `result_json=''` 4중 가드.
  - `buildSpawnFailureExclusion()` — `NCO_SCORER_SPAWN_FAILURE_EXCLUSION=off|0|false`로 런타임 무효화.
  - 3개 terminal CASE(48h/7d/all)에만 삽입. completed CASE는 손대지 않았다.
- `src/core/team-scorer.test.ts`
  - 산출물 없는 ENOENT는 제외(87.5%), **산출물이 있는 ENOENT 실패는 계속 카운트**,
    토글 off 시 원복(77.8%)을 검증하는 테스트 1건 추가.
- 전체 diff: `08-IMPROVEMENTS/team-content-planning-cycle1-scorer.patch`
  - `git apply --check --reverse` → exit `0`

## 3. 실측 효과 (dist + 실 DB, T1)

```json
{
 "before(off)": {"score": 83.4, "grade": "B", "completion": 87.5, "n": 8, "sample": "48h"},
 "after(on)":   {"score": 94.4, "grade": "A", "completion": 100,  "n": 7, "sample": "48h"},
 "rollback(off)":{"score": 83.4, "grade": "B", "completion": 87.5, "n": 8, "sample": "48h"}
}
```

블라스트 반경 — 활성 팀 68개 전체 재계산:

```json
{"totalTeams": 68,
 "changed": [{"teamId": "team_content-planning", "from": 83.4, "to": 94.4, "nFrom": 8, "nTo": 7}],
 "over100": []}
```

불변식 확인(실 DB):
- `status='completed' AND error LIKE '%Command failed with ENOENT:%'` → **0건**
  → `completed ⊆ terminal` 유지, completion>100% 회귀 없음(위 `over100: []`와 일치).
- 이 error 클래스 전체 4건(전부 `failed`, response·result_json 모두 0B) 중
  `team_id`가 붙은 것은 `task_content_generation` 1건뿐(나머지 3건은 `team_id` NULL).

## 4. 빌드·테스트 증거

| 명령 | 결과 |
|---|---|
| `npx tsc --noEmit` | exit `0` |
| `npm run build` | exit `0`, `dist/core/team-scorer.js` 재생성(03:30:03 KST) |
| `npx vitest run src/core/team-scorer.test.ts` | Test Files 1 passed / Tests **7 passed** |
| `npx vitest run src/core/cron-scheduler.team-scores.test.ts src/core/team-lifecycle.test.ts` | 2 passed / 10 passed |
| `npm run test:run` (전체) | Test Files 120 passed, **1 failed** / Tests 673 passed, 1 failed, exit `1` |

전체 회귀의 유일한 실패는 `tests/근거.test.ts > 최신 포인터가 오늘 날짜를 가리킨다`:
`expected '2026-07-27' to be '2026-07-28'` — `data/team-runner/*.last` 포인터의 KST 날짜 롤오버
문제이며 이 변경과 무관하다(선행 cycle 문서에도 동일 실패가 기록되어 있다). 수정하지 않았다.

## 5. 등급·Gap·롤백

- [등급] **T1** — DB 행, 파일 내용, 컴파일된 dist 실행 결과, 명령 종료코드를 직접 확인.
- [Gap]
  - ENOENT가 발생한 **정확한 커널 수준 원인은 미확인**(같은 시각 형제 태스크는 성공했으므로
    영구적 PATH/cwd 결함은 배제됨). 제외 조건은 "산출물 0 + 프로세스 미기동"으로만 좁혀 두었고
    실제 원인 규명은 별도 과제로 남는다.
  - 런타임 NCO(pid 10569, dist 기동 시각 02:46 KST)는 **재시작 전이라 새 scorer를 아직 로드하지 않았다.**
    위 수치는 dist 모듈 직접 실행으로 측정했다. 서비스 반영은 미검증.
  - 변경은 **미커밋**(working tree). 커밋 여부는 지시받지 않아 수행하지 않았다.
- [미검증항목]
  - `task_content_generation`·`task_trend_collector`는 NCO 저장소 어디에서도 생성 코드가 발견되지
    않는 **외부 주입 고정 ID 행**이다(프롬프트가 지시문이 아니라 상태 문구, 매일 같은 ID로 재생성).
    특히 `task_trend_collector`는 `completed`인데 response 0B·result_json 0B로 **분자를 부풀린다**.
    이 데이터 정합성 문제는 주입 주체를 특정하지 못해 이번 범위에서 고치지 않았다.
  - 팀 lifecycle/status/retirement 필드는 조회도 변경도 하지 않았다.
- [롤백]
  - 런타임 즉시: `NCO_SCORER_SPAWN_FAILURE_EXCLUSION=off` (재빌드 불필요, 위 rollback 측정으로 실증)
  - 코드: `git apply --reverse 08-IMPROVEMENTS/team-content-planning-cycle1-scorer.patch`

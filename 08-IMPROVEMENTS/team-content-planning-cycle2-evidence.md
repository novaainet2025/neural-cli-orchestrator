# 콘텐츠 기획팀 개선 cycle 2 — 0B completed 분자 제외 검증 영수증

검증일: 2026-07-28 (Asia/Seoul)

## 1. 시작 상태와 cycle 1 재검증

- 실제 프로젝트/현재 checkout: `/Users/nova-ai/project/nco`
- 시작 branch/HEAD: `main` / `7eb7dd41e4dc6285440c8ab476749c63f00b75a6`
- `src/core/team-scorer.ts`와 `src/core/team-scorer.test.ts`는 작업 시작 시 dirty가 아니었다.
  cycle 1의 `SPAWN_FAILURE_EXCLUSION_SQL`, `buildSpawnFailureExclusion()`, 회귀 테스트는
  위 HEAD에 이미 커밋되어 있었다. 따라서 cycle 1 코드는 재구현하거나 되돌리지 않았다.
- 시작 시 다른 작업의 dirty 파일 10개가 이미 존재했다. 이 세션은 이 문서와 아래 scorer
  2개 파일 외의 기존 dirty 변경을 수정·스테이징·커밋하지 않았다.

검증 도중 다른 프로세스가 `main` HEAD를
`9201a2291197ac02c85ef712a5086f4e25801297` (`Improve team Collaboration Mesh and Protocol`)
로 이동시켰다. 이 커밋은 scorer 2개 변경을 기존 다른 작업 11개 파일과 함께 포함했지만
이 증거 문서는 포함하지 않았다. 이 세션은 `git add`/`git commit`을 실행하지 않았다.
아래 최종 검증은 이동한 현재 HEAD `9201a229...`를 기준으로 다시 수행했다.

새 규칙을 끈 상태에서 cycle 1 spawn 토글을 실 DB와 새로 emit한
`dist/core/team-scorer.js`로 재계산했다.

| 설정 | score | grade | completion | n | sample | completion>100% |
|---|---:|---|---:|---:|---|---:|
| zero-output `off`, spawn `off` | 83.4 | B | 87.5% | 8 | 48h | 0팀 |
| zero-output `off`, spawn `on` | 94.4 | A | 100% | 7 | 48h | 0팀 |

따라서 HR 입력 `83.4/B/87.5%/n=8`은 cycle 1 spawn 제외가 꺼진 값이며,
cycle 1 토글의 on/off 원복은 직접 재현됐다.

## 2. 실제 DB 근거와 근본원인

읽기 전용 `db/nco.db` 조회 결과:

```text
id                    team_id                status     assigned_to  created_at           completed_at         response_bytes  result_bytes
task_trend_collector  team_content-planning  completed  mlx          2026-07-27 15:00:04  2026-07-27 15:00:09  0               0
```

최근 48시간에 `team_id`가 있는 completed 행 중 `response`와 `result_json`이 모두
0바이트인 행은 **1건**, 영향 팀은 **1팀**이었다.

```text
team_content-planning: task_trend_collector (1건)
```

`task_trend_collector`는 검증 가능한 산출물이 없지만 `status='completed'`라는 이유만으로
기존 completion 분자에 포함됐다. cycle 1 spawn 제외를 켜면 terminal 분모는 7인데
completed 분자도 7이 되어 100%가 됐다. 근본원인은 “완료 상태”와 “산출물 존재”를 동일시한
completed 집계이며, 이 때문에 completion 분자가 1 부풀었다.

## 3. 변경

### `src/core/team-scorer.ts`

- `buildZeroOutputCompletedExclusion()` 추가.
- 기본값은 on이며 `NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION=off|0|false`로 즉시 원복 가능.
- 48h/7d/all의 **completed 분자 CASE에만** 아래 조건을 적용:
  - `response` 0B **그리고** `result_json` 0B이면 분자에서 제외.
  - 둘 중 하나라도 1B 이상이면 완료 산출물로 유지.
- terminal 분모 CASE는 변경하지 않았다. 따라서 0B completed는 실패와 동일하게 분모에는
  남고, `completed <= terminal` 및 `completion <= 100%` 방향의 불변식을 보존한다.

### `src/core/team-scorer.test.ts`

- 기존 완료 fixture에 실제 산출물 본문을 명시해 테스트 데이터 의미를 보존.
- 다음 회귀를 추가:
  - response 산출물만 있는 completed 유지.
  - result_json 산출물만 있는 completed 유지.
  - 둘 다 0B인 completed는 분자에서만 제외.
  - 토글 on: `2/4=50%`, off: `3/4=75%`, 두 경우 모두 `n=4`.
  - 모든 계산 결과가 completion 100% 이하인지 확인.

팀 lifecycle/status/retirement 데이터와 팀 활성화 상태는 조회·변경하지 않았다.

## 4. 실측 결과

새 규칙 기본 on에서 실 DB를 재계산한 결과:

| zero-output | spawn | score | grade | completion | n | sample |
|---|---|---:|---|---:|---:|---|
| on | on | 81.5 | B | 85.7% | 7 | 48h |
| on | off | 72.2 | C | 75% | 8 | 48h |

zero-output 토글만 `off → on`으로 바꾼 블라스트 반경:

```json
{
  "teams": 68,
  "changed": [{
    "teamId": "team_content-planning",
    "from": {"score": 94.4, "completion": 100, "n": 7},
    "to": {"score": 81.5, "completion": 85.7, "n": 7}
  }],
  "over100": []
}
```

이 cycle은 점수를 높였다고 주장하지 않는다. 산출물 없는 completed 성공 1건을 제거해
기존 100%가 과대계상임을 드러낸 데이터 정합성 수정이다.

## 5. 검증 결과

| 명령/확인 | 직접 관측 결과 |
|---|---|
| `npx tsc --noEmit` | exit 0, 출력 없음 |
| `npx vitest run src/core/team-scorer.test.ts` (HEAD `9201a229...`) | Test Files 1 passed, Tests 9 passed |
| 같은 명령 (후속 외부 provider-auth dirty 변경 포함 최종 tree) | Test Files 1 passed, Tests 10 passed |
| `npx vitest run src/core/cron-scheduler.team-scores.test.ts src/core/team-lifecycle.test.ts` | Test Files 2 passed, Tests 10 passed |
| `npx tsc` | exit 0 |
| `PATH=.../node_modules/.bin:$PATH node --import tsx scripts/run-with-work-event.ts --event-type regression:build -- tsc` | exit 0; package build wrapper와 같은 ledger runner/tsc 인수로 실행 |
| `dist/core/team-scorer.js` 내용/mtime | 새 함수와 3개 삽입부 존재, `2026-07-28 04:17:24 KST` |
| `npm run build` | **exit 1**; tsx IPC pipe `listen EPERM` |
| `curl http://localhost:6200/api/health` | **exit 7**; `Failed to connect to localhost port 6200` |

`npm run build`의 직접 오류:

```text
Error: listen EPERM: operation not permitted /var/folders/.../tsx-501/25254.pipe
code: 'EPERM'
syscall: 'listen'
```

컴파일 자체와 동일 ledger runner는 exit 0이지만, 요청된 npm wrapper 명령은 이 실행
샌드박스가 tsx의 Unix IPC socket listen을 차단해 exit 0으로 관측하지 못했다.

## 6. 증거 등급, Gap, 미검증항목, 롤백

- [등급] **T1 / Evidence Tier 1** — Git hash·파일 내용·읽기 전용 DB 행·컴파일된 dist의
  실 DB 계산 결과·명령 출력을 현재 작업에서 직접 확인.
- [Gap]
  - 정확한 `npm run build`는 코드 컴파일 전 tsx CLI IPC 단계에서 `EPERM`으로 실패했다.
    직접 `npx tsc`와 IPC를 사용하지 않는 동일 ledger runner 호출은 통과했다.
  - HEAD 검증 직후 다른 작업이 같은 scorer source/test에 평문 provider-auth 제외와 테스트를
    추가했다. 편집 도중 실행한 중간 테스트는 새 테스트 1건이 실패했지만, source 수정 완료
    시각 뒤 재실행은 최종 10건 모두 통과했다. 이 요청 범위가 아니므로 외부 변경을 수정하거나
    되돌리지 않았다.
  - NCO `localhost:6200`이 내려가 있어 실행 중 서비스의 HTTP score route 반영은 확인하지 못했다.
  - 정정 후 콘텐츠 기획팀 completion은 85.7%다. `task_trend_collector`를 0B completed로
    기록한 producer 자체의 수정은 이번 scorer 범위에 포함하지 않았다.
- [미검증항목]
  - 실행 중 NCO 프로세스 재시작/환경변수 주입 및 `/api/teams/scores` 응답.
  - npm wrapper가 Unix socket listen 가능한 비샌드박스 환경에서의 실행.
- [커밋 상태/결정]
  - 이 세션은 **추가 커밋하지 않음**. 요청된 `npm run build` exit 0과 런타임 HTTP 검증을
    확보하지 못했기 때문이다.
  - 다만 다른 프로세스의 동시 커밋 `9201a229...`가 scorer source/test 변경을 이미 포함했다.
    증거 문서는 untracked다. 이후 같은 scorer 2개 파일에는 또 다른 작업의 provider-auth
    변경이 dirty로 추가됐다. 최종 status에는 그 작업의 `.cb-classify-probe.mts`, 기존
    `db/hnsw-indices/retired-provider.hnsw`, 이 증거 문서도 uncommitted 상태로 남아 있다.
- [롤백]
  - 런타임: `NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION=off`
  - 코드: `buildZeroOutputCompletedExclusion()`과 세 completed CASE 삽입부 및 해당 회귀
    테스트만 제거. cycle 1 spawn 제외 코드는 유지.

---

## 7. cycle 2 재검증 패스 (2026-07-28 04:23 KST, 후속 세션)

이 패스는 **코드를 재구현하지 않았다**. 목적은 (a) §5의 미해결 `npm run build` gap 종료,
(b) 토글 on/off 원복의 독립 재현, (c) 커밋 여부 결정이다.

### 7.1 시작 상태 확인 (T1)

`git show HEAD:src/core/team-scorer.ts` 직접 조회 결과, cycle 1·cycle 2 코드는 이미
HEAD `9201a22`에 **커밋되어 있다**. HR 지시문의 "미커밋 M 상태"는 stale하다.

| 심볼 | HEAD `9201a22` 내 위치 |
|---|---|
| `SPAWN_FAILURE_EXCLUSION_SQL` / `buildSpawnFailureExclusion()` | L356 / L363, 삽입부 L446 |
| `ZERO_OUTPUT_COMPLETED_EXCLUSION_SQL` / `buildZeroOutputCompletedExclusion()` | L382 / L387, 삽입부 L471·L489·L505 |

현재 워킹트리의 `team-scorer.ts` M 상태는 이 팀 작업이 아니라 **다른 세션의
`team_hr-incubator-2026-w30` provider-auth 평문 제외 작업**이다(동일 트리의 untracked
`docs/self-improve/hr-incubator-2026-w30-cycle2-evidence-2026-07-28.md`와 대응).
검증 중 해당 diff가 42줄→41줄로 바뀌어 **동시 편집 중**임을 확인했다. 이 세션은 그
파일들을 수정·스테이징·커밋하지 않았다.

### 7.2 명령 재실행 (T1)

| 명령 | 관측 결과 |
|---|---|
| `npx tsc --noEmit` | **exit 0**, 출력 0줄 |
| `npx vitest run src/core/team-scorer.test.ts` | **Test Files 1 passed, Tests 10 passed** |
| `npm run build` | **exit 0** ← §5의 `EPERM` gap 해소 |
| `dist/core/team-scorer.js` | build로 재생성, mtime `2026-07-28 04:23` |

§5의 `npm run build` exit 1(tsx IPC `listen EPERM`)은 이 패스에서 재현되지 않았고
exit 0으로 통과했다. 샌드박스 조건 차이에 따른 환경 의존 실패였다.

### 7.3 토글 매트릭스 실측 (T1)

`sqlite3 .backup`으로 뜬 일관 스냅샷 `/tmp/nco-cp-cycle2.db`(566MB)에 대해 방금 빌드한
`dist/core/team-scorer.js`의 `computeTeamScores()`를 4조합으로 직접 호출:

| zero-output | spawn | score | grade | completion | n | sample | completion>100% 팀 |
|---|---|---:|---|---:|---:|---|---:|
| off | off | **83.4** | B | **87.5%** | 8 | 48h | 0 / 68 |
| off | on | **94.3** | A | **100%** | 7 | 48h | 0 / 68 |
| on | off | 72.1 | C | 75% | 8 | 48h | 0 / 68 |
| **on** | **on** (현재 기본값) | **81.5** | **B** | **85.7%** | 7 | 48h | 0 / 68 |

- HR 입력 `83.4 / 87.5% / n=8`은 `off/off` 조합과 **정확히 일치** → HR 스냅샷이 두 제외
  규칙이 꺼진 상태의 pre-patch 값임이 확정됐다.
- `off/on`은 §1의 `94.4`가 아니라 **94.3**으로 측정됐다. 48h 창이 약 6분 이동해 volume
  성분이 미세하게 달라진 결과이며, grade `A`와 completion `100%`는 동일하다.
  이 문서는 `94.4`를 재주장하지 않고 실측값 `94.3`을 기록한다.
- 4조합 전부 68팀 중 `completion>100%` 팀 **0건** → 회귀 없음.

### 7.4 근본원인 독립 재확인 (T1)

`team_content-planning`의 48h 태스크 9건 전수:

```text
task_gudqikH8LkuQ6-Cy  failed     opencode      07-26 00:03  resp=0 res=0  Circuit breaker open for agent opencode
task_xxMo-aMaiO3ofrpO  completed  claude-code   07-26 05:08  resp=952
task_JAg7_6r9hm4tuMtG  completed  agy           07-26 08:00  resp=2196
task_mUctLweT5Iuokwf9  completed  agy           07-26 15:00  resp=1689
task_bdP-dIFNni_P814l  completed  agy           07-27 00:00  resp=1424
task_wbmNJYskCFXrjmCE  completed  agy           07-27 05:12  resp=1633
task_trend_collector   completed  mlx           07-27 15:00  resp=0 res=0   ← 0B 산출물
task_NTFmch7UjbcOYnqh  completed  agy           07-27 15:00  resp=1742
task_content_generation failed    cursor-agent  07-27 17:10  resp=0 res=0  CLI failed exit=unknown
```

산술 검증: CB 실패 1건은 기존 규칙이 제외 → 분모 8. spawn 제외 on이면 
`task_content_generation`도 빠져 분모 7, 분자 7 → 100%. 여기서 0B 규칙을 켜면 
`task_trend_collector`가 **분자에서만** 빠져 6/7 = **85.7%**. 실측 표와 정확히 일치한다.

블라스트 반경 — 48h 내 team_id가 붙은 completed 중 response·result_json 모두 0B인 행:

```text
team_content-planning  1
```

**DB 전체에서 1팀 1행.** 규칙이 과도하게 넓지 않음을 확인했다.

### 7.5 이 패스의 diff

- `src/core/team-scorer.ts` — **이 세션 변경 0줄** (이미 HEAD에 커밋됨, 재구현 금지 준수)
- `src/core/team-scorer.test.ts` — **이 세션 변경 0줄**
- `08-IMPROVEMENTS/team-content-planning-cycle2-evidence.md` — 본 §7 추가

### 7.6 커밋 결정

- **코드: 추가 커밋 불필요** — cycle 1·2 scorer 코드는 이미 `9201a22`에 있다.
- **증거 문서만 path-scoped 커밋** — `git add`는 이 파일 하나로 한정했다. 동시 편집 중인
  다른 세션의 scorer/circuit-breaker/agent-manager dirty 변경은 스테이징하지 않았다.
- 되돌리기: 이 커밋은 문서 1개 추가이므로 `git revert <hash>` 또는 파일 삭제로 원복된다.
  스코어러 동작 롤백은 §6의 환경변수 토글이 그대로 유효하다.

### 7.7 이 패스의 미검증항목

- 실행 중 NCO 서비스(`localhost:6200`) 재시작 후 `/api/teams/scores` HTTP 응답 반영 —
  §5와 동일하게 **미확인**(게이트웨이 다운). 점수는 라이브러리 직접 호출로만 검증했다.
- `task_trend_collector`를 0B로 기록한 `nco-team-runner` cron producer 자체의 수정 —
  scorer 범위 밖이며 이번에도 손대지 않았다.
- 다른 세션의 provider-auth 변경이 최종 merge된 뒤의 통합 상태 — 편집 진행 중이라
  이 세션 시점의 값으로만 검증했다.

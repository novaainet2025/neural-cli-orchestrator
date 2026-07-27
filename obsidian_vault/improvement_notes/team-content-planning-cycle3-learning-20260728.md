# team_content-planning cycle 1~3 최종 학습 노트

작성일: 2026-07-28 (Asia/Seoul)
대상: 콘텐츠 기획팀 (`content-planning`, `team_content-planning`)
범위: 기존 수정의 재구현이 아니라 cycle 1~3 증거 정리와 stale 스냅샷 재작업 루프 방지

## [사이클 타임라인]

| 시점 | 사이클 | 직접 확인한 이력 | 이번 cycle의 처리 |
|---|---|---|---|
| 2026-07-28 03:58:42 KST | cycle 1 진단 | `7eb7dd41e4dc6285440c8ab476749c63f00b75a6`에 `team-content-planning-cycle1-*` 증거 문서가 추가됨 | 확정 사실을 전제로 사용하고 원인 재조사 안 함 |
| 2026-07-28 04:12:26 KST | 수정 반영 | `9201a2291197ac02c85ef712a5086f4e25801297`에 spawn ENOENT terminal 제외와 0바이트 completed 분자 제외 및 회귀 테스트가 포함됨 | 코드 재구현 안 함 |
| 2026-07-28 04:25:41 KST | 증거 고정 | `93a6f8c8d5b9a568f1d933f27a83de5340990e0a`가 cycle 2 재검증 문서를 커밋함. 문서가 기록한 재검증 패스의 scorer 코드 diff는 0줄임 | 커밋된 규칙과 증거를 기준선으로 사용 |
| 2026-07-28 04:39:24 KST | cycle 2 감사 | HEAD `a8c285a3d65340f27627d8f3327bd8fd5a091690`의 감사 문서는 당시 HEAD 직접 계산 `81.5/B/85.7%/n=7`과 라이브 HTTP `83.4/B/87.5%/n=8`의 불일치를 기록함 | 현재 라이브 상태와 혼동하지 않도록 역사적 관측으로만 보존 |
| 2026-07-28 04:51 KST | cycle 3 학습 | 현재 DB 48시간 표본 `n=9`; 현재 빌드 산출물 직접 계산은 `on/on=81.5/B/85.7%/n=7`, `off/off=83.4/B/87.5%/n=8` | 지시문 수치만 보고 재작업하지 않고 배포·토글·스냅샷 신선도를 먼저 확인하도록 교훈화 |
| 2026-07-28 04:54:58 KST | 동시 통합 | 작업 중 HEAD가 `d1a23cecadf015051318b2a8506f61c32cd008ae`로 이동함. `a8c285a..d1a23ce`의 scorer diff는 별도 provider-auth 제외 추가이며 이 팀의 spawn/0B 규칙은 불변 | 새 HEAD에서 타입체크·집중 테스트·빌드·점수를 다시 검증 |
| 2026-07-28 05:09 KST | cycle 3 종결 확인 | NCO 백엔드가 재기동됨(`/health` `uptime=497.8s`, 즉 기동 ≈ `05:00:24 KST`, HEAD `d1a23ce` 커밋 `04:54:58` 이후). 라이브 `GET /api/teams/scores` 본문 = `81.5 / B / 85.7% / n=7` | **HEAD 기본(on/on) 계산치와 라이브가 일치 → 이 노트가 남겨 두었던 "라이브 unknown" 갭이 닫힘. 코드 변경 없이 배포(재시작)만으로 해소됨** |

cycle 1에서 확정된 근본원인 두 건은 요청에 따라 재조사하지 않았다. 이번 cycle은 현재
DB 행이 이미 커밋된 규칙에 어떻게 매핑되는지만 다시 측정했다.

## [실측 표본 표(task_id/status/원인/제외규칙 매핑)]

조회 기준 시각은 SQLite `datetime('now') = 2026-07-27 19:51:42 UTC`, 시작 경계는
`2026-07-25 19:51:42 UTC`다. `산출물 bytes`는 스코어러가 판정에 사용하는
`response + result_json`의 UTF-8 바이트 수이며, 다음 식으로 측정했다.

```sql
length(CAST(COALESCE(response,'') AS BLOB))
+ length(CAST(COALESCE(result_json,'') AS BLOB))
```

| task_id | status | 원인 | 산출물 bytes | `artifacts.content` bytes | 제외규칙 매핑 |
|---|---|---|---:|---:|---|
| `task_gudqikH8LkuQ6-Cy` | failed | `Circuit breaker open for agent opencode (generic)` | 0 | 0 | 기존 `INFRA_EXCLUSION` 매칭. 신규 spawn/0B-completed 규칙은 둘 다 비매칭 |
| `task_xxMo-aMaiO3ofrpO` | completed | error 없음, 산출물 있음 | 1,850 | 0 | 제외 안 함 |
| `task_JAg7_6r9hm4tuMtG` | completed | error 없음, 산출물 있음 | 4,239 | 0 | 제외 안 함 |
| `task_mUctLweT5Iuokwf9` | completed | error 없음, 산출물 있음 | 3,398 | 0 | 제외 안 함 |
| `task_bdP-dIFNni_P814l` | completed | error 없음, 산출물 있음 | 2,278 | 0 | 제외 안 함 |
| `task_wbmNJYskCFXrjmCE` | completed | error 없음, 산출물 있음 | 3,199 | 0 | 제외 안 함 |
| `task_trend_collector` | completed | error는 없지만 `response`와 `result_json` 모두 0바이트 | 0 | 0 | `ZERO_OUTPUT_COMPLETED_EXCLUSION` 매칭: terminal 분모에는 유지하고 completed 분자에서 제외 |
| `task_NTFmch7UjbcOYnqh` | completed | error 없음, 산출물 있음 | 3,443 | 0 | 제외 안 함 |
| `task_content_generation` | failed | error에 `Command failed with ENOENT: cursor-agent` 포함, 산출물 없음 | 0 | 0 | `SPAWN_FAILURE_EXCLUSION` 매칭: terminal 집계에서 제외 |

표본 집계는 `n=9`, completed 7건, failed 2건, timed_out 0건, lease_expired 0건,
비종결 0건이다. 스코어러 산출물은 합계 18,407바이트다. 이 9건과 연결된
`artifacts` 행은 0건이며 `artifacts.content` 합계도 0바이트다. 따라서 이 표에서
`artifacts.content=0`은 `response/result_json` 산출물이 없다는 뜻이 아니다.

실패 또는 부분완료로 재분류할 사례는 세 건이다.

1. `task_gudqikH8LkuQ6-Cy`: 두 신규 규칙 대상은 아니지만 기존 인프라 제외가 이미 처리한다.
2. `task_trend_collector`: completed 상태만 있고 검증 가능한 스코어러 산출물이 없어 0바이트
   completed 규칙이 완료 분자에서 제외한다.
3. `task_content_generation`: CLI가 시작되지 않은 ENOENT·0바이트 실패라 spawn 규칙이
   terminal 분모에서 제외한다.

## [확정 근본원인과 수정 커밋 해시]

재조사하지 않고 기준선으로 삼은 확정 사실은 다음 두 건이다.

1. 콘텐츠 생성 경로의 `cursor-agent` spawn ENOENT는 팀 산출물 품질 실패가 아니라 CLI
   프로세스가 시작되지 않은 가용성 사건인데 terminal 분모에 계상됐다.
2. `status='completed'`이지만 `response`와 `result_json`이 모두 0바이트인 행이
   completed 분자에 들어가 completion을 부풀렸다.

수정 커밋:

- `9201a2291197ac02c85ef712a5086f4e25801297`
  - `SPAWN_FAILURE_EXCLUSION_SQL`
  - `ZERO_OUTPUT_COMPLETED_EXCLUSION_SQL`
  - 환경변수로 되돌릴 수 있는 두 builder와 회귀 테스트

증거 커밋:

- `93a6f8c8d5b9a568f1d933f27a83de5340990e0a`
  - cycle 2 재검증, 토글 매트릭스, 코드 재구현 불필요와 diff 0 기록

현재 `src/core/team-scorer.ts` 내용에서도 두 SQL과 builder 및 48h/7d/all 집계 삽입부를
직접 확인했다. 런타임 롤백 토글은
`NCO_SCORER_SPAWN_FAILURE_EXCLUSION=off`와
`NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION=off`다.

## [잔여 갭]

- ~~현재 `localhost:6200`은 연결 실패이므로 라이브 서빙 점수는 unknown이다.~~
  **[2026-07-28 05:09 KST 해소]** 백엔드 재기동 후 라이브 HTTP 본문이
  `team_content-planning: 81.5 / B / 85.7% / n=7 (48h)`로 HEAD 기본 계산치와 일치한다.
  cycle 2의 라이브 `83.4/87.5%/n=8`은 pre-patch 프로세스가 서빙하던 역사적 관측치였다.
- NCO 재시작은 이 노트 작업이 아니라 별도 커밋 `d1a23ce`("Restart nco-backend to reflect
  fix") 경로로 이루어졌다. 이 작업에서는 서비스·HR lifecycle/status/retirement 데이터를
  변경하지 않았다. **HR 스냅샷(`score=83.4/completion=87.5%`) 자체의 갱신은 여전히 미수행이며
  HR 소관이다** — 갱신 전까지 동일 stale 수치로 cycle이 재발할 수 있다.
- 같은 산출물의 중복 파일 `team-content-planning-cycle3-learning-2026-07-28.md`가 존재한다
  (날짜 표기 변형). 그 파일의 "산출물 바이트수" 열은 실제로는 SQLite `length()`의 **문자 수**이며
  UTF-8 바이트 수가 아니다(예: `task_NTFmch7UjbcOYnqh` 1,742자 = 3,443바이트). 수치가 상충하는 게
  아니라 단위 라벨이 다르다. 본 문서를 정본으로 삼는다.
- `task_trend_collector`가 0바이트 completed를 쓰는 upstream producer는 이번 학습 노트
  범위 밖이라 수정하지 않았다. 스코어러 계상 오류는 방어되지만 upstream 기록 원인은 남아 있다.
- 정확한 패키지 명령 `npm run typecheck`, `npm run test`, `npm run build`는 진단·테스트 전
  `tsx` IPC 소켓의 `listen EPERM`으로 실패했다. IPC를 쓰지 않고 동일
  `run-with-work-event.ts`에 `tsc --noEmit`/`tsc`를 전달한 경로는 각각 exit 0이지만,
  패키지 wrapper 통과로 바꾸어 말하지 않는다.
- 작업 시작부터 존재한 다른 dirty 파일 20개와 prunable worktree 2개는 수정·정리하지 않았다.
  작업 도중 동시 커밋 `d1a23ce...`가 HEAD를 이동시킨 뒤에도 이 작업의 변경은 본 문서 1개뿐이다.

## [일반화 교훈]

지시문 점수가 stale일 가능성이 있으면 점수 차이 자체를 새 코드 결함으로 간주하지 않는다.
다음 순서로 증거를 분리한다.

1. 지시문 수치의 표본 창·토글·생성 시각과 현재 Git HEAD를 식별한다.
2. 같은 DB 표본에서 현재 HEAD 스코어러를 직접 호출해 수치를 재계산한다.
3. HEAD 계산이 이미 수정값이고 코드 diff가 0이면 재구현을 중단한다.
4. 라이브 HTTP 본문, 실행 프로세스의 기동 시각, 배포된 build, 런타임 토글을 확인한다.
5. HEAD와 라이브가 다르면 코드 재작업보다 배포/재시작 누락 또는 환경변수 불일치를 먼저
   의심한다. 라이브가 내려가 있으면 점수를 추정하지 않고 `unknown`으로 둔다.
6. 라이브 반영을 T1 HTTP 본문으로 확인한 뒤 HR 스냅샷 갱신을 요청한다. HR 수치가
   갱신되기 전에는 같은 stale 지시문으로 새 개선 cycle을 시작하지 않는다.
7. 조회 결과가 없으면 `n=0, 판정 보류`로 끝내며, 작은 표본을 보간하거나 목표 수치로
   역산하지 않는다.

이 cycle의 지시문 `83.4/87.5%/n=8`은 현재 DB와 빌드 산출물에서 두 토글을 모두 끈
`off/off` 조합으로 직접 재현됐다. 기본 `on/on` 계산은 `81.5/85.7%/n=7`이다. 따라서
지시문 수치만 반복 투입해 같은 코드를 다시 고치는 것은 재발방지가 아니라 중복 작업이다.

**이 교훈은 이번 cycle 안에서 실증됐다.** 5단계("HEAD와 라이브가 다르면 배포/재시작 누락을
먼저 의심")대로 조치한 결과, 코드 diff 0으로 라이브가 `83.4 → 81.5`로 바뀌어 HEAD와 일치했다.
즉 cycle 2~3에서 관측된 불일치의 원인은 **스코어러 결함이 아니라 프로세스가 pre-patch
바이너리를 서빙하던 배포 지연**이었다. 남은 불일치(HR 지시문의 83.4)는 코드가 아니라
HR 스냅샷 갱신 주기의 문제이므로, 다음 cycle이 같은 수치로 열리면 **재작업이 아니라
"스냅샷 갱신 요청"으로 종결**해야 한다.

## [검증 영수증: 명령어·출력·증거등급(T1/T2)]

- [변경] `obsidian_vault/improvement_notes/team-content-planning-cycle3-learning-20260728.md`
  한 파일 추가. 코드·DB 스키마·팀 lifecycle 변경 없음.
- [검증방법] `sqlite3 -readonly -header -column db/nco.db "<48h query>"`
  → `n=9`, completed 7, failed 2, zero scorer-output 3,
  scorer output 합계 18,407바이트, 연결 artifact content 합계 0바이트.
- [검증방법] 같은 DB에서 세 예외 사례의 조건식을 CASE로 실행
  → CB `INFRA_EXCLUSION=MATCH`, trend `zero-output=MATCH`,
  content generation `spawn-ENOENT=MATCH`.
- [검증방법] `git rev-parse 9201a22 93a6f8c HEAD` 및 `git show -s`
  → 수정 `9201a229...`, 증거 `93a6f8c8...`, 현재 HEAD `d1a23cec...`.
- [검증방법] `node ... computeTeamScores(db)` (방금 생성한 `dist`)
  → `on/on: 81.5/B/85.7%/n=7`; `off/off: 83.4/B/87.5%/n=8`.
- [검증방법] `npx vitest run src/core/team-scorer.test.ts`
  → `Test Files 1 passed (1)`, `Tests 11 passed (11)`.
- [검증방법]
  `PATH="$PWD/node_modules/.bin:$PATH" node --import tsx scripts/run-with-work-event.ts --event-type regression:typecheck -- tsc --noEmit`
  → exit 0.
- [검증방법]
  `PATH="$PWD/node_modules/.bin:$PATH" node --import tsx scripts/run-with-work-event.ts --event-type regression:build -- tsc`
  → exit 0.
- [검증방법] `npm run typecheck`, `npm run test`, `npm run build`
  → 셋 다 exit 1, `Error: listen EPERM: operation not permitted .../tsx-501/*.pipe`.
- [검증방법] `run-delivery-gate.sh --full`
  → exit 4, `PASS=0 FAIL=4 SKIP=0`; worktree inspection과 세 package wrapper가 FAIL.
- [검증방법] `curl -sS --max-time 5 http://localhost:6200/api/health` 및
  `/api/teams/scores` (2026-07-28 04:5x KST)
  → 둘 다 exit 7, `Failed to connect to localhost port 6200`.
- [검증방법] (2026-07-28 05:08~05:09 KST, 재기동 후 재측정)
  `curl -sS http://localhost:6200/health`
  → `{"status":"healthy",...,"runtime":{"redis":true,"agentsOnline":9,"uptime":497.838572084}}`;
  `curl -sS http://localhost:6200/api/teams/scores`
  → `{"teamId":"team_content-planning","slug":"content-planning","name":"콘텐츠 기획팀",
  "organizationId":"org_sns-blog","score":81.5,"grade":"B","completion":85.7,"n":7,"maxN":89,
  "sample":"48h"}`. **T1 (HTTP 응답 본문 직접 확인)** — 라이브가 HEAD 기본값과 일치.
- [검증방법] `sqlite3 -readonly db/nco.db` 48h 재조회(2026-07-27 20:08:39 UTC 기준)
  → 위 표와 동일한 9행·동일 바이트수 재현. `length()` vs `length(CAST(... AS BLOB))` 대조로
  중복 노트의 단위 차이(문자 수 vs 바이트) 확인.
- [검증방법] `npx tsc --noEmit` (HEAD `d1a23ce`) → exit 0, 출력 0줄.
- [검증방법] `npx vitest run src/core/team-scorer.test.ts` (재실행)
  → `Test Files 1 passed (1)`, `Tests 11 passed (11)`.
- [Evidence Tier 1 / T1] 현재 작업에서 직접 읽은 DB 행·파일 내용·Git object/hash·컴파일
  출력·테스트 출력·HTTP 연결 오류를 근거로 사용했다.
- [Evidence Tier 2 / T2] 프로세스 존재 여부는 별도 판정하지 않았고 T2 증거를 사용하지 않았다.
  라이브 판정은 T1 HTTP 시도 결과인 연결 실패까지만 기록했다.
- [Gap] 패키지 wrapper와 현재 라이브 HTTP는 비통과/미확인 상태로 보존한다.
- [되돌리기] 이 신규 문서만 삭제하거나 향후 문서 커밋을 `git revert`한다. scorer 동작은
  위 두 환경변수 토글로 독립 원복 가능하다.

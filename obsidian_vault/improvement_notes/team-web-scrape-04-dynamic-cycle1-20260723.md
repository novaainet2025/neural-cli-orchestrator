---
created_at: 2026-07-23T22:31:42+09:00
updated_at: 2026-07-23T22:47:30+09:00
verified_at: 2026-07-23
tags:
  - improvement-note
  - category/team-quality
  - team/web-scrape-04-dynamic-implementation
  - nco/provider
  - nco/hooks
  - nco/mesh
  - nco/mem0
  - evidence/T1
  - cycle/1
---

# 04 Dynamic Browser Implementation — self-learning cycle 1

## Scope and safety

- 대상: `team_web-scrape-04-dynamic-implementation`
- 지시 기준선: score 90, completion 100%, sample all/1, cycle 1/3
- 팀 삭제·비활성화·lifecycle 상태 변경은 하지 않는다.
- 아래 수치는 서로 다른 집계 정의를 섞지 않는다. 지시 기준선, task DB 행,
  48시간 task 집계, 에이전트 상태 스냅샷을 각각 별도 증거로 취급한다.
- 이 파일은 저장소의 Obsidian 미러에 둔 동기화 대기 노트다. 외부 원본 vault
  `/Users/nova-ai/obsidian/mac-obsidian`는 현재 쓰기 허용 범위 밖이라 수정하지 않았다.

## Root cause

핵심 원인은 **task의 `completed` 상태와 증거가 완결된 성공을 같은 것으로 취급한 것**이다.

1. 대상 팀의 유일한 공식 표본 `task_c5lRFTDPAcg2tHWm`은 `completed`지만
   `verifier_json`, `verifier_result_json`, `evidence_json`이 모두 비어 있다. 응답은
   파일 접근 불가를 이유로 DynamicFetcher 구현, allowlist, stealth, 광고 차단을 전부
   `미확인`으로 남겼다.
2. 실제 구현은 이미 `src/services/webScrapingService.ts`,
   `src/server/routes/web-scraping.ts`, `integrations/scrapling/nco_scrapling/policy.py`,
   `integrations/scrapling/nco_scrapling/runner.py`에 존재한다. 따라서 표본의 미확인은
   구현 부재가 아니라 **수집 모드와 검증 게이트가 업무 목표에 맞지 않았던 증거 공백**이다.
3. 이어진 자가학습 응답 `task_mTYuZGRvl-Id1K9u`는 무관한
   `nova-use/docs/plans/browser-control-extension-port.md` 편집 시도 설명을 반환했다.
   build verifier는 통과했지만 응답 내용과 회사 목표는 일치하지 않았다.
4. 현재 개선 태스크 `task_pXv4MxFZ5_UuRcTX`는 `FORMAT_MISMATCH` 뒤
   `orphan_requeue_count=2`, `status=queued`였다. 즉 형식 반려와 재큐잉은 있었지만,
   의미적 증거 완결성을 복구하지 못했다.
5. Mem0는 검증된 교훈보다 원문 실패를 더 많이 보존한다. 22:43 KST 재관측 시
   `mem0_entries` 9,451건 중 2,332건이 `FORMAT_MISMATCH` 문자열을 포함했고
   15건이 `[thinking]`을 포함했다. `knowledge_base`는 3,546건 중 3,538건의
   `used_count=0`이며, `learning_events`는 0건이다.

## Ground-truth evidence

### 1. Team and task history

관측 시각: 2026-07-23T22:31:42+09:00, source `db/nco.db`.

| Evidence | Observed value | Interpretation |
|---|---:|---|
| Team row | active=1, always_on=0, lead=opencode | lifecycle 변경 없음 |
| Team-owned tasks | completed 1 | 지시의 sample all/1과 일치 |
| `task_c5lRFTDPAcg2tHWm` | completed, 43s, verifier/evidence 없음 | 전송 완료이지 검증 완료 증거는 아님 |
| `task_pXv4MxFZ5_UuRcTX` | queued, orphan requeue 2 | 개선 체인의 재시작 불안정 |
| opencode 48h tasks | total 90, completed 62, failed-like 26 | 나머지 상태 2건; API 성공률과 정의가 다름 |
| codex 48h tasks | total 307, completed 268, failed-like 35 | 나머지 상태 4건; API 성공률과 정의가 다름 |

원본 일일 산출물에 주입된 `/api/agents` 스냅샷은 opencode
`idle/2031/73%/24h 실패 13`, codex `working/2316/95%/24h 실패 16`이었다.
이는 task DB 48시간 집계와 산식·관측 시점이 다르므로 직접 비교하거나 새 성공률을
계산하지 않는다.

### 2. Dynamic browser implementation

소스 직접 확인 결과:

- `src/services/webScrapingService.ts`: `static|dynamic|stealth`, 별도 Python 프로세스,
  환경변수 allowlist, stdout/stderr/timeout/concurrency 상한.
- `src/server/routes/web-scraping.ts`: 저장된 활성 authorization reference와
  target/`allowedDomains`를 재대조한 뒤에만 adapter 호출.
- `policy.py`: dynamic/stealth는 비어 있지 않은 `allowedDomains`와 exact target host를
  요구하고 사설·loopback·예약 IP를 차단.
- `runner.py`: `DynamicFetcher`, `block_ads`, service worker 차단,
  browser host resolver pinning, request route 차단을 사용.
- stealth는 `stealthAuthorization`과 운영자
  `NCO_SCRAPLING_ENABLE_STEALTH=1`을 모두 요구하며 Cloudflare 자동 해결을 끈다.

따라서 이전 산출물의 “DynamicFetcher 구현 상태 미확인”은 최신 소스 기준으로
교정해야 한다. 실제 허가 사이트를 대상으로 한 운영 E2E는 이번 범위에서 수행하지
않았으므로 여전히 미확인이다.

### 3. Provider status

- 로컬 CLI: opencode `1.4.5`, codex `0.145.0`.
- agent DB 스냅샷: opencode `idle`, codex `working`, 두 행 모두
  `2026-07-23 13:39:45` UTC 갱신.
- `GET http://localhost:6200/api/activity`: 연결 거부. 따라서 NCO provider API의
  실시간 응답과 DB 상태의 end-to-end 일치는 미확인이다.

### 4. Hook status

- `.claude/settings.json`은 `SessionStart`, `UserPromptSubmit`, `Stop` 훅을 등록한다.
- 프로젝트 훅 5개는 모두 `bash -n`을 통과했다.
- 호스트는 Darwin 25.5.0 arm64이고 `flock`이 설치되어 있지 않다.
  `session-start.sh`의 이름 예약 경로는 `flock -w 5`에 의존하므로 macOS에서
  정상적인 원자 예약을 보장하지 못한다.
- `/tmp/nco-sessions`에는 당일 갱신된 결과가 있으나, 파일의 `changed_files`는
  전역 dirty worktree를 집계한다. 개별 task 완료 증거로 승격하지 않는다.

### 5. Mesh and inter-session

- NCO DB `mesh_sessions`: 0건.
- NCO API `:6200`: 연결 불가.
- 별도 inter-session 상태 파일은 version 173512, coordinator `claude-2`,
  session 6건이며 모든 `last_seen`이 22:39~22:40 KST로 신선했다.
- `messages.log`: 5,858행, 마지막 수정 21:34:22 KST.
- 결론: inter-session 플러그인의 상태 갱신은 관측되지만 NCO mesh와의 연결은
  end-to-end로 확인되지 않았다. 두 상태면을 같은 “mesh 정상”으로 표현하면 안 된다.

### 6. Obsidian freshness

- 재검증 시 `00-SYSTEM/SECOND-BRAIN.md` 생성 시각과 master context 동기화
  시각은 모두 2026-07-23 22:40:01이었다.
- 문서는 NCO API를 `localhost:6200`으로 안내하지만 이번 실측에서는 offline이었다.
- provider runtime 표의 `hermes-nco` 행은 version 칸에 오류를 표시하면서 status는
  `ok`라서 상태 의미가 모순된다.
- 이 노트는 실제 task/source/DB 점검으로 위 두 상태 불일치를 보완한다. 외부 vault
  동기화 완료 여부는 미확인이다.

## Bounded fix

삭제나 기존 항목 재작성 없이 다음 정제 항목을 고정 ID로 추가한다.

| Store | ID | Purpose |
|---|---|---|
| improvement note | `web-scrape-04-cycle1-evidence-completion-gap-20260723` | 문제·원인·검증 경로 보존 |
| knowledge base | `kb-web-scrape-04-cycle1-evidence-rule-20260723` | 완료 상태와 증거 완결성 분리 규칙 |
| Mem0/opencode | `mem0-web-scrape-04-cycle1-evidence-rule-20260723` | 다음 팀 실행 전에 검색할 짧은 교훈 |

정제 기억의 규칙:

> Dynamic browser task에서 `completed`만으로 구현 상태를 확정하지 않는다.
> 소스 4개, task verifier/evidence, 관련 테스트 결과를 확인한다. 반려 프롬프트 원문과
> 도구 호출 서술은 증거가 아니다.

## Improvement backlog

1. P0 — `session-start.sh`에 Darwin용 원자 lock fallback을 별도 hook 개선 작업으로
   추가하고 동시 실행 회귀 테스트를 만든다.
2. P0 — NCO API offline, `mesh_sessions=0`, inter-session 6 sessions의 상태면 분리를
   health report에 노출한다.
3. P1 — Mem0 자동 수집에서 `FORMAT_MISMATCH`, `[thinking]`, 도구 함수 설명을
   장기기억으로 바로 승격하지 않고 정제 큐로 보낸다.
4. P1 — knowledge base의 `used_count=0` 항목을 출처·중복·신뢰도 기준으로 감사한다.
   이번 cycle에서는 삭제하지 않는다.
5. P1 — 팀 개선 태스크의 완료 조건에 `evidence_json` 또는 task별 verifier 영수증을
   요구하고, 전역 build 통과만으로 의미적 성공을 판정하지 않는다.
6. P1 — 실제 외부 사이트 대신 허가·DNS·service-worker 동작을 통제한 fixture로
   dynamic browser E2E를 추가한다.
7. P2 — 외부 Obsidian 원본 vault가 쓰기 가능한 운영 경로에서 이 노트를 동기화하고
   `SECOND-BRAIN.md` 재생성 시각을 확인한다.

## Rollback

- 파일: 이 노트 한 개만 제거한다.
- DB: 위 표의 정확한 ID 3개만 삭제한다.
- 팀, team goal, task, authorization, 기존 Mem0/knowledge base 행은 변경하지 않는다.
- HR의 lifecycle·retirement 권한을 침범하지 않는다.

## Verification receipt

- `[build] npm run build` → exit 0, TypeScript `tsc` 통과.
- `[focused TypeScript] npm run test:run --
  src/server/routes/web-scraping.test.ts src/services/webScrapingService.test.ts` →
  2026-07-23 22:46 KST 재실행, 2 files, 7/7 tests passed.
- `[quality gate regression]` 위 2개 파일에
  `tests/response-quality.test.ts`, `tests/task-intake.test.ts`를 더해 재실행 →
  2026-07-23 22:47 KST, 4 files, 20/20 tests passed. 일반 보고는 `done:` 프로토콜
  prefix를 사용해야 한다는 현재 게이트 동작을 포함한다.
- `[실패 이력] npm test`에 응답 레이블 `결과:`가 추가 인자로 전달된 실행은
  Vitest가 이를 파일 필터(`filter: 결과:`)로 해석해 대상 0개, exit 1이 되었다.
  이는 테스트 실패가 아니라 잘못된 필터를 포함한 호출 실패이며, 위의 정확한
  파일 경로 명령으로 22:46 KST에 재검증했다.
- `[adapter] PYTHONPATH=integrations/scrapling .../.venv/bin/python -m unittest
  discover ...` → 11/11 tests passed.
  - 첫 `python -m pytest` 시도는 해당 `.venv`에 pytest가 없어 실행되지 않았다.
    테스트 파일이 `unittest.TestCase` 기반임을 확인한 뒤 내장 runner로 재실행했다.
- `[hooks] bash -n .claude/hooks/*.sh` → 5/5 syntax pass.
- `[database] PRAGMA quick_check` → `ok`; `PRAGMA foreign_key_check` → 위반 0행.
- `[memory] mem0Service.search(opencode, "DynamicFetcher evidence completed
  evidence-complete")` → 첫 결과
  `mem0-web-scrape-04-cycle1-evidence-rule-20260723`.
- `[DB rows]` improvement note, knowledge base, Mem0 고정 ID 3개를 직접 조회했다.
- `[미검증]` 실제 허가 사이트 dynamic E2E, 외부 Obsidian 원본 vault 동기화,
  NCO API/mesh end-to-end 복구, semantic embedding 생성.
- score 90의 개선 여부는 다음 독립 표본 전까지 주장하지 않는다.

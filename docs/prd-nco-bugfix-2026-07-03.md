# PRD — NCO 버그·에러·개선 통합 수정

> 출처: `docs/nco-bug-audit-2026-07-03.md` (분산 병렬 감사, ~101건) · 작성: claude-3 · 2026-07-03
> 상태: **설계 단계** — 실행은 사용자 승인(빌드/재시작 허용 + 범위) 후 착수

## 1. 목표
감사에서 발견된 버그·에러·개선사항을 **근본원인 3개 테마 + 심각도 티어**로 재구성해, 중복 없는 파일그룹 단위로 **confirm-real→수정→tsc/test→리뷰** 파이프라인을 순차·병렬 실행한다. 개별 패치 100개가 아니라 **공통 게이트로 다수 결함을 흡수**하는 것을 우선한다.

## 2. 베이스라인 & 제약 (T1 확인)
- **동작 방식**: NCO는 `dist/`(컴파일본)에서 실행 → `src/` 편집은 **빌드+재시작 전까지 무해(inert)**. 위험 단일 지점 = **빌드+재시작**(라우팅 중인 오케스트레이터 중단). [[feedback_restart_inflight_check]] 준수: 재시작 전 in-flight 수 확인 + 공지.
- **더티 트리**: 현재 `src/` tracked 12 + untracked 101 변경(내 세션 이전분). → 내 수정과 격리 위해 **작업 브랜치 필요**(§7).
- **tsc 베이스라인**: 착수 시점 `npx tsc --noEmit` 결과를 기준선으로 고정(`scratchpad/tsc_baseline.txt`). 베이스라인이 이미 더럽다면 "내 수정이 tsc를 깼는가"는 **delta 기준**으로만 판정.
- **프로바이더 가용성(변동적)**: 정상=codex·opencode·openrouter·agy·nvidia·hermes(가변). 불안정=cursor-agent·copilot·mlx. **병렬 폭은 실측 가용 수에 종속** — 매 티어 착수 전 `/api/agents` 재확인.
- **신뢰도**: 발견 ~101건 중 ~93건 T4(에이전트 보고). spot-check 실측 오차율 **1/8**. → **수정 전 항목별 confirm-real(소스 직접 Read) 필수.**

## 3. 개선 테마 (근본원인 — "개선사항"의 본체)
개별 결함을 아래 3개 공통 수정으로 롤업한다.

### TH-1 · Fail-as-Success 제거 (성공 판정 게이트 통일)
실패(비정상 종료/취소/타임아웃/빈 출력/에러 마커)를 성공경로로 흘리는 계열.
- 대상: `orchestrated-loop.ts:108,298`, `agent-manager.ts:185`, `agent-tools.ts:223`, `utils/summarizer.ts:40`, `workflow-pipeline.ts:160`, `audit/threatEscalation.ts:62`, `verification/response-quality.ts:59`
- 수정 방향: **공통 `isSuccessfulResult()` 게이트** — exitCode≠0 / isCanceled / abort / 에러마커 / 빈 출력을 명시적 실패로 분류하고 하류(circuit/quality/task-state)에 실패 전파. `reject:false` 실행부는 종료코드를 반드시 결과에 반영.

### TH-2 · 원자성 (동시성 read-modify-write 보호)
Redis/SQLite 무보호 RMW로 상태 유실·중복.
- 대상: `sync-engine.ts:21,87`, `event-bus.ts:123,203`, `kanban-engine.ts:76,97`, `shared-state.ts:164`, `invocation-tracker.ts:180`, `collaboration-engine.ts:166,190`, `cli-mesh.ts:211-243,375`, `audit/merkleLog.ts:90`
- 수정 방향: Redis는 **Lua/WATCH-MULTI** 원자 연산, SQLite는 **트랜잭션(IMMEDIATE)** 래핑. 락 release는 소유자 토큰 확인(compare-and-del). event publish/xadd는 원자 파이프라인 + xack 재시도.

### TH-3 · 게이트 기본값 반전 (불충분 시 거부)
검증/보안 게이트가 실패·무맥락·빈값을 기본 통과.
- 대상: `cross-validator.ts:60,181`, `hallucination-guard.ts:54`, `quality-gate.ts:190`, `audit/merkleLog.ts:73`, `security/acquisition-policy.ts:69`, `security/sandbox-manager.ts:115`
- 수정 방향: `jaccard` 빈셋 → 0(불일치), consensus 임계 상향, grounding 무맥락 → 낮은 기본값, merkle 해시에 `severity` 포함, deny-by-default 실제 적용, Commander `allowedCommands` 명시 허용목록으로 대체.

## 4. 심각도 티어 & 파일그룹 (병렬 단위 = 비중첩 파일)
각 그룹은 독립 파일집합 → 병렬 안전(worktree 격리). `confirm` 열: T1=코디 재현확정, T4=미확인(수정 전 confirm-real 필수).

### 티어 0 — CRIT (12) · 최우선
| 그룹 | 파일 | 핵심 결함 | confirm |
|---|---|---|---|
| G-SANDBOX | security/{path-guard,sandbox-manager,command-gate,falseReportGuard}.ts | symlink 우회·Commander 전명령 허용·shell주입 | T4 |
| G-AUTH | server/middleware/{authJwt,ipRateLimit}.ts | 하드코딩 시크릿·XFF 우회 | **T1** |
| G-AGENTLOOP | agent/{orchestrated-loop,agent-manager,agent-tools}.ts | 실패=성공(TH-1) | **T1**(108/298) |
| G-SYNC | core/sync-engine.ts | 자기유발 동기화 루프 | **T1** |
| G-VALIDATION | core/{cross-validator,hallucination-guard,quality-gate}.ts | 빈셋=합의(TH-3) | **T1**(60) |
| G-MEMORY | core/{vector-memory,sleep-consolidator,knowledge-base}.ts | 삭제 후 HNSW 미동기(정합성) | **T1**(198) |
| G-AUDIT | audit/{merkleLog,emergencyService,threatEscalation}.ts | severity 해시누락·정지 데드락 | **T1**(73) |
| G-REDIS | storage/{redis,database}.ts | broken-client 캐시·마이그레이션 무트랜잭션 | **T1**(정정) |

### 티어 1 — HIGH (41) · 그룹 재사용
G-ORCH(core/{supervisor-engine,delegation-manager,collaboration-engine,discussion-engine,harness-orchestrator,ensemble-engine,workflow-pipeline}), G-QUEUE(core/{event-bus,kanban-engine,cron-scheduler,task-queue,shared-state,invocation-tracker}), G-MESH(core/cli-mesh + hooks/*), G-UI(client/*,monitoring/*,bridge/*), G-STORAGE(server/routes/fleet-ops), G-UTILS(utils/*), G-MCP(mcp/server.ts).

### 티어 2 — MED/LOW (23) · HIGH 수정에 합류 또는 후순위

## 5. 성공 기준 (티어별 배리어)
- `npx tsc --noEmit` delta = 0 (베이스라인 대비 신규 에러 0)
- 기존 `/api/*` 엔드포인트 응답 유지 (스모크: health/agents/tasks)
- 관련 `tests/` 통과 (해당 모듈)
- **항목별 T1 검증 영수증** (confirm-real 근거 + 수정 diff + 재현/회귀 결과)
- 보안 CRIT은 PoC 재현→수정후 재현불가 확인

## 6. 실행 모델 (순차 병렬)
```
per 티어:
  1) confirm-real: 그룹 파일 직접 Read로 T4→T1 승격 (거짓 발견 폐기)
  2) 병렬(비중첩 그룹): opencode 설계 → codex 구현(worktree 격리) → cursor-agent/agy 리뷰
  3) 배리어: tsc delta=0 + 스모크 + 테스트 → 통과해야 다음 티어
  4) 티어 종료 시 1회 빌드+재시작(in-flight=0 확인·공지 후)
```
- 병렬 폭 = min(가용 프로바이더, 비중첩 그룹 수). 실패 프로바이더는 codex/opencode로 재배정.
- **동일 파일 2에이전트 동시편집 금지** — 파일그룹이 배타 단위.

## 7. 리스크 & 미해결 결정(사용자 확인 필요)
- **R1 더티 베이스라인**: 세션 이전 src 변경 113건 처리 방식 — (a)그대로 위에 브랜치 (b)기존 변경 커밋 후 브랜치 (c)stash. → 사용자 결정.
- **R2 빌드+재시작**: 오케스트레이터 재시작 필요 시점·허용 여부. → 사용자 승인.
- **R3 범위**: CRIT-우선 점진 vs 전 심각도 일괄. → 사용자 선택.
- **R4 자기수정**: NCO가 자기 소스를 수정 → 수정 중 NCO 장애 시 파이프라인 중단 가능. worktree 격리 + dist inert로 완화.

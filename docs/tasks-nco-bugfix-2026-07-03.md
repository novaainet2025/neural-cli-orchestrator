# TASKS — NCO 버그수정 실행 백로그

> PRD: `docs/prd-nco-bugfix-2026-07-03.md` · 감사: `docs/nco-bug-audit-2026-07-03.md`
> tsc 베이스라인: **0 errors (clean)** @2026-07-03 20:58 · in-flight: 0
> 규칙: 각 태스크 = 비중첩 파일그룹(병렬 안전). `[C]`=confirm-real 필요(T4), `[V]`=T1 확정. 착수 전 `[C]` 항목은 소스 Read로 승격.
> **confirm-real 완료(T1, 코디 직접 Read):** authJwt(시크릿)·ipRateLimit(XFF)·orchestrated-loop:108/298·sync-engine:21·cross-validator:60·merkleLog:73·sleep-consolidator:198·path-guard:53·sandbox-manager:115·command-gate:45·event-bus:123·redis(정정). ⚠️PLAUSIBLE: vector-memory:360. **미확인 잔여는 수정 착수 시 확인.**

## ✅ 티어 0 (CRIT) 소스수정 완료 — 2026-07-03 21:29
- 8그룹(G-AUTH+G-SANDBOX+G-AGENTLOOP+G-SYNC+G-VALIDATION+G-MEMORY+G-AUDIT+G-REDIS) codex 위임 수정.
- **검증(코디 T1):** 전체 `tsc --noEmit`=0(베이스라인 0 대비 delta 0), 변경파일 22개=예상범위 정확(scope creep 0), 고위험 7건 직접 Read 리뷰(path-guard·falseReportGuard·orchestrated-loop·merkleLog·cross-validator·redis·sync-engine 모두 정확), sleep-consolidator 단위테스트 1/1 pass.
- **미완:** 런타임 검증(빌드+재시작 필요=사용자 승인 대기). G-AUTH는 死코드(무해). merkleLog BEGIN IMMEDIATE 중첩 트랜잭션 시 예외 위험(latent).

## ✅ 티어 1 (HIGH) 소스수정 완료 — 2026-07-03 21:38
- 6그룹: G-ORCH·G-QUEUE·G-STORAGE2·G-UTILS(codex) + G-UI(agy) + G-MCP(codex). **G-MESH(TK-13)은 claude-1/2가 name-shuffle로 담당 → 제외.**
- **검증(코디 T1):** 전체 tsc=0(delta 0), 변경 23파일=예상범위, G-UI(AgentMonitor 동적 wss+백오프 재연결)·event-bus(multi() 원자 pub/xadd) 직접 Read 확인.
- **주의:** collector가 G-UI(agy)·G-MCP를 status/text 기준 FAIL로 오표기했으나 **파일은 정상 편집됨**(mtime+내용+tsc 확인) — false-negative.
- **미완:** 런타임 검증(빌드+재시작 대기), Tier2 MED/LOW 잔여분(다수는 동일파일 수정에 흡수됨).

## 실행 순서
```
T0(CRIT) 8그룹 → 배리어(tsc+스모크) → 빌드/재시작 → T1(HIGH) 7그룹 → 배리어 → T2(MED/LOW)
각 티어 내부는 병렬(비중첩 그룹). 그룹 내부는 confirm→설계→구현→리뷰 순차.
```

---

## 티어 0 — CRIT (병렬 8그룹)

### TK-01 · G-SANDBOX  [V부분]  ⟶ codex(구현)+cursor-agent/agy(리뷰)
> confirm-real 완료(T1): path-guard.ts:53(부모 symlink·미존재파일 우회)·sandbox-manager.ts:115(Commander allowCommands:[])·command-gate.ts:45(basename 우회) **확정**. falseReportGuard.ts:70·acquisition-policy.ts:69 수정 착수 시 확인. (추가 latent: sandbox-manager.ts:98 `ncoRoot` WSL경로 하드코딩 — Mac에서 실제 nco root 미허용)
- 파일: `src/security/{path-guard,sandbox-manager,command-gate,falseReportGuard,acquisition-policy}.ts`
- 수정:
  - path-guard.ts:53 — 경로의 **모든 상위 세그먼트 realpath** 검사(부모 symlink 차단) + 미존재 파일도 부모 realpath 검증
  - sandbox-manager.ts:115 — Commander `allowedCommands:[]` → **명시 허용목록**(TH-3)
  - command-gate.ts:45 — basename 비교 → **절대경로 resolve 후 allowlist 매칭**
  - falseReportGuard.ts:70 — `bash -c evidence.target` 제거 → **화이트리스트 검증기**(임의 셸 금지)
  - acquisition-policy.ts:69 — 게이트 0개 시 deny-by-default 실제 적용
- 검증: PoC(symlink escape, `/tmp/git` 위장) 재현→수정후 차단 확인 + `tests/` 보안 테스트

### TK-02 · G-AUTH  ✅ 완료(2026-07-03 21:14, codex) — 검증: tsc=0, 코드 직접 Read 확인
> ⚠️ **중요**: authJwt.ts/ipRateLimit.ts는 **어디서도 import 안 됨 + dist/ 미포함 = 死코드**. 따라서 이 CRIT들은 실행 중인 서버에서 **실제 미노출(latent)**. 수정은 위생 목적으로 유지. 만약 향후 라우트에 연결하면 `.env`에 ACCESS_TOKEN_SECRET/REFRESH_TOKEN_SECRET 필수(현재 미설정 — fail-fast throw). 재시작 무해(미로드).
### TK-02 · G-AUTH  [V]  ⟶ codex (원본 스펙)
- 파일: `src/server/middleware/{authJwt,ipRateLimit}.ts`
- 수정: 하드코딩 폴백 시크릿 제거(미설정 시 **부팅 실패 fail-fast**) + `jwt.verify` `algorithms:['HS256']` 고정 + rate-limit 키를 신뢰 프록시 기반 `request.ip`로 고정(XFF 스푸핑 차단) + store 상한
- 검증: 미설정 env 부팅거부 확인, 위조 토큰 401, XFF 스푸핑 무효 curl

### TK-03 · G-AGENTLOOP  [V]  ⟶ opencode(설계 TH-1)+codex
- 파일: `src/agent/{orchestrated-loop,agent-manager,agent-tools}.ts`
- 수정: 공통 `isSuccessfulResult()` 게이트(TH-1). abort/exitCode/isCanceled/에러마커/빈출력 → 실패 전파. agent-tools `runCommand` 종료코드 반영, `shell:true` 주입 방어
- 검증: 취소/실패 시뮬 → task-state가 failed 기록 확인, 회귀 테스트

### TK-04 · G-SYNC  [V]  ⟶ codex
- 파일: `src/core/sync-engine.ts`
- 수정: updateHook 재진입 가드(플러시 중 hook 무시 플래그) 또는 forwardSync가 UPDATE 대신 Redis-only write. recoverySync non-online 일괄 offline 제거
- 검증: agents UPDATE 1회 → forwardSync 1회만(로그 카운트), I/O 루프 부재

### TK-05 · G-VALIDATION  [V]  ⟶ codex
- 파일: `src/core/{cross-validator,hallucination-guard,quality-gate}.ts`
- 수정(TH-3): jaccard 빈셋→0, consensus 임계 상향, grounding 무맥락 낮은값, quality-gate 실제 best 반환
- 검증: 빈/에러 응답쌍 → consensus=false 단위테스트

### TK-06 · G-MEMORY  [C/V]  ⟶ codex
- 파일: `src/core/{vector-memory,sleep-consolidator,knowledge-base}.ts`
- 수정: prune/delete 시 HNSW `markDelete` 동기 + rebuildIndex **빈 인덱스 신규 생성**(디스크 재로드 금지) + vector INSERT를 SQLite 트랜잭션 후 addPoint + knowledge-base projectPath/category 스코프
- 검증: 삭제 후 검색 orphan 없음, rebuild 후 카운트 일치. **`vector-memory.ts:360`은 `getOrCreateIndex` 동작 confirm-real 선행**

### TK-07 · G-AUDIT  [V]  ⟶ codex
- 파일: `src/audit/{merkleLog,emergencyService,threatEscalation}.ts`
- 수정: computeHash에 `severity` 포함(TH-3) + appendAudit 트랜잭션(TH-2) + verifyChain limit 제거/페이징 + verifyEntry 체인검증 + 위협수준 다운그레이드/재정지 데드락 가드 + Level2/3 실제 조치 구현
- 검증: severity 변조 시 검증 실패 확인, 비상정지 해제 후 재정지 없음

### TK-08 · G-REDIS  [V]  ⟶ codex
- 파일: `src/storage/{redis,database}.ts`
- 수정: getRedis connect 실패 시 client 캐시 무효화+재시도, database 마이그레이션 트랜잭션 래핑 + 파일읽기 오류 처리
- 검증: Redis 다운 시뮬 → 재연결, 마이그레이션 중단 시 롤백

**배리어-0**: 8그룹 tsc delta=0 + `curl /health /api/agents /api/v2/tasks` 정상 + 보안/코어 테스트 → 통과 시 빌드+재시작(in-flight=0 확인·공지).

---

## 티어 1 — HIGH (병렬 7그룹)
- TK-11 G-ORCH: core/{supervisor-engine,delegation-manager,collaboration-engine,discussion-engine,harness-orchestrator,ensemble-engine,workflow-pipeline}.ts (11 HIGH)
- TK-12 G-QUEUE: core/{event-bus,kanban-engine,cron-scheduler,task-queue,shared-state,invocation-tracker}.ts (8, TH-2)
- TK-13 G-MESH: core/cli-mesh.ts + hooks/{nco-name-resolver,inter-session-name,mesh-register,mesh-heartbeat,mesh-inbox-poller}.sh + setup.sh (claude-2 발견 15, 락 표준 통일)
- TK-14 G-UI: client/components/*.tsx + monitoring/metrics.ts + bridge/types.ts (WS 하드코딩·재연결·NaN·동기쿼리)
- TK-15 G-STORAGE2: server/routes/fleet-ops.ts (pushReports TTL·length 변조)
- TK-16 G-UTILS: utils/{summarizer,intent-parser,config,binaryTree,fibonacci,file-logger}.ts
- TK-17 G-MCP: mcp/server.ts (폴링 예산 동적화·res.ok·에러전파)

**배리어-1**: 동일 기준.

## 티어 2 — MED/LOW (23)
HIGH 수정에 합류 가능분 흡수, 잔여는 후순위 백로그. 각 그룹 담당 에이전트가 동일 파일 수정 시 함께 처리.

---

## 담당/병렬 배정 (가용 실측 후 확정)
| 우선 | 정상 프로바이더 | 폴백 |
|---|---|---|
| 설계(TH-1~3) | opencode | nvidia |
| 구현 | codex | openrouter |
| 리뷰 | cursor-agent | agy |
| 검증 | ollama | codex(재확인) |
> 매 티어 착수 전 `/api/agents`로 가용 재확인, 불안정 프로바이더는 codex/opencode 재배정(감사 때 실증된 패턴).

## 미결정 (사용자 승인 대기)
1. 더티 베이스라인(src 113변경) 처리: 위에 브랜치 / 커밋후 / stash
2. 빌드+재시작 허용 여부·시점
3. 범위: **CRIT 우선 점진**(권장) vs 전 심각도 일괄

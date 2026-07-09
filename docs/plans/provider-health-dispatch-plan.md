# 프로바이더 헬스 기반 디스패치 완전화 설계 (2026-07-08, claude-3)

목표: 리밋/장애 프로바이더의 자동 제외·폴백·복구를 완전하게 만들어 위임 병목 제거.
근거: 최근 300태스크 실측 — mlx 실패 32(커넥션13+서킷11), codex quota 6, claude-code silent 5+미로그인 3, ollama 큐대기 타임아웃 5건 전멸.

## 소유권/경계 (claude-2 합의, msg 2fd10929)
- work-report-scheduler.ts 수정 금지 (claude-2 소유)
- `metadata.allowProviderFailover=true` 발행 경로 하위호환 유지
- 409 provider_gated 응답 스키마·failover 응답 필드 불변

## G1 [HIGH] 능동 프로브 — 게이트 복구가 실태스크 희생에 의존하는 문제
파일: `src/agent/agent-manager.ts` `healthCheckApiProvider()` (:402-440), `src/security/circuit-breaker-registry.ts`
- (a) 헬스 GET 200 성공 시: `getAvailability(id).status === 'probe'` 이고 `reason !== 'quota'` 이면 `recordSuccess(id)` 호출 → generic/rate-limit 게이트는 헬스 성공으로 복구.
  - `recordSuccess()`가 open(probe-eligible) 상태에서도 closed로 전이하는지 확인, 아니면 전이 허용 추가.
- (b) quota 게이트: 헬스 200은 복구 증거 불충분. cooldownUntil 경과 + reason==='quota' 프로바이더에 한해 **1토큰 실완성 프로브** (`max_tokens:1`, prompt "ping") 를 ApiExecutor 경유 발사. 성공→recordSuccess, 실패→recordFailure(재게이트+백오프).
- (c) 프로브 쿨다운: 프로바이더당 최소 10분 간격 (`lastQuotaProbeAt: Map<string, number>` 인메모리, 재시작 시 리셋 허용).
- (d) CLI 프로바이더(Type B)는 이번 범위 제외 (플래그 `activeProbe: false` 기본) — 후속.
- 엣지: 프로브 중 동시 실태스크 성공 시 이중 recordSuccess 무해(멱등). 프로브 자체 타임아웃 10s.
- 테스트: registry에 quota-open+cooldown경과 상태 주입 → 헬스루프 1틱 → completion probe 발사·성공 시 closed 확인.

## G2 [HIGH] commander 가용성 판정 통일
파일: `src/core/commander.ts` `pickAvailableAgent()` (:244)
- 현행: `getSnapshot(id).state !== 'open'` → 변경: `const a = circuitBreakerRegistry.getAvailability(id); usable = enabledIds.has(id) && (a.available || a.status === 'probe')`
- gateway/smart-router와 동일 술어. probe 허용은 selectTaskProvider(:166)와 동일 의미론.
- 테스트: half-open/probe/gated:quota 각 상태에서 usable 판정이 gateway와 일치.

## G3 [HIGH] 큐 대기 vs 실행 타임아웃 분리 (백로그 #18)
파일: `src/core/task-queue.ts` `enqueueBullMQ()` (:712-735), `getBullWaitTimeoutMs()` (:937)
- 현행: `job.waitUntilFinished(events, hardTimeout+30s)` — 큐 대기 포함이라 동시성1 프로바이더에 N건 큐잉 시 뒤 태스크 전멸.
- 변경(2단계 대기):
  1. `waitForJobActive(job, events, QUEUE_WAIT_MAX_MS)` — 'active' 이벤트 대기 (기본 30분, env `NCO_QUEUE_WAIT_MAX_MS` 오버라이드). 초과 시 에러 메시지 `queue_wait_timeout: provider <id> busy for <ms>ms` 로 실패 처리.
     - attach 전 이미 active/completed 레이스: 먼저 `await job.getState()` 확인 후 이벤트 구독.
  2. active 확인 후 `job.waitUntilFinished(events, hardTimeout+30s)` — 실행에만 예산 적용.
- `queue_wait_timeout` 을 `src/server/task-failover.ts` `RETRYABLE_FAILOVER_PATTERNS`에 추가 → 대기 전멸 태스크는 자동으로 다른 프로바이더 폴백.
- semaphore 경로(:737-)는 이미 acquire 대기와 실행 분리돼 있어 변경 불필요.
- 테스트: concurrency 1 큐에 3건 투입, 1건당 실행 t초 — 2·3번째가 exec 예산으로 죽지 않고 순차 완료. QUEUE_WAIT_MAX 초과 시 폴백 발동.

## G5 [MED] 헬스프로브 멀티키 인지
파일: `src/agent/agent-manager.ts` (:414)
- 현행 `process.env[ref]?.split(',')[0]` → `getApiKeys(ref)` (config.ts:203) 사용, 라운드로빈 인덱스(프로바이더별 카운터 % keys.length)로 순환 — 특정 키 하나가 죽었을 때 헬스 판정이 그 키에 고정되는 문제 제거.

## G6 [LOW] 죽은 env 정리
파일: `.env.example`
- `WORKER_CONCURRENCY`, `WORKER_VLLM_CONCURRENCY`, `WORKER_RATE_LIMIT_RPM`, `WORKER_VLLM_RATE_LIMIT_RPM` 제거 + 주석: "동시성/RPM은 config/ai-providers.json의 concurrency/rateLimitRpm이 단일소스".

## G4 [MED, 후속] RPM 선제 스로틀
- rateLimitRpm 토큰버킷을 task-queue 디스패치 직전 적용. A~C 검증 후 별도 커밋.

## 구현 순서/커밋 분할
1. 커밋1: G2+G6 (저위험)  2. 커밋2: G3 (+failover 패턴)  3. 커밋3: G1+G5  4. (후속) G4
성공 기준: `npx tsc --noEmit` 0에러, 기존 /api/* 불변, vitest 신규 테스트 통과.

## 태스크 체크리스트
- [ ] G2 commander 판정 통일
- [ ] G6 env 정리
- [ ] G3 큐대기/실행 타임아웃 분리 + failover 패턴 추가
- [ ] G1 능동 프로브 (generic/rate-limit=헬스복구, quota=1토큰 프로브)
- [ ] G5 헬스프로브 키 로테이션
- [ ] tsc 0에러 + 신규 테스트
- [ ] claude-2와 배포/재시작 조율

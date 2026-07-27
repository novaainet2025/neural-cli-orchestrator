# Source Discovery (tech-port-01-source-discovery) 실패 및 지연 원인 분석

## 1. 근본 원인 분석 (Root Cause Analysis)
- `team_tech-port-01-source-discovery`의 목표 점수(83.1)가 완료율(87.5%) 대비 낮게 형성된 주요 원인은, 기술 탐색/리서치 및 업무 보고서 작성 시 **불필요한 코드 빌드 검증기(buildDefaultVerifier)**가 할당되어 발생하는 `FORMAT_MISMATCH` 및 무한 재시도 루프에 있습니다.
- NCO 태스크 생성부(`src/server/task-intake.ts`)에서 프롬프트 자동 보강 시 `[검증기준] 빌드/타입체크 통과` 와 같은 코드 작업 패턴이 탐지될 경우, 시스템은 강제로 `npm run build` 검증기를 붙입니다.
- 빌드 검증기가 붙으면 `requireProtocolPrefix=true` 규칙이 활성화되어, LLM이 반환하는 자유 형식의 보고서(프로토콜 prefix 누락)가 `FORMAT_MISMATCH`로 반복 반려(reject)됩니다.
- 반려가 누적되며 워커 에이전트(`claude-code`, `ollama` 등)의 Circuit Breaker가 Open되고, 대기열(queue) 타임아웃이 발생하여 최종적으로 태스크가 실패 처리되었습니다.

## 2. 에이전트별 실패 패턴 요약
DB에서 확인된 총 6건의 실패 로그 패턴:
1. **claude-code**:
   - `Circuit breaker open for agent claude-code (generic)` (1건)
   - `queue_wait_timeout: provider claude-code busy for 1800000ms` (1건)
2. **ollama**:
   - `Circuit breaker open for agent ollama (generic)` (1건)
3. **NCO (Verification Gate)**:
   - `quality_rejected: FORMAT_MISMATCH` (1건)
   - `unknown: failure pattern in output` (1건)
   - `orphaned: server restart (poison — requeued 2x)` (1건)

## 3. 개선 제안 및 조치 리스트
1. **[완료] 태스크 인테이크 예외 처리 추가**:
   - `src/server/task-intake.ts`의 `buildDefaultVerifierWithFs` 함수에서 `RESEARCH_STRATEGY_TEAM_ID`와 동일하게 `SOURCE_DISCOVERY_TEAM_ID`에 대해서도 기본 빌드 검증기 부착을 제외하도록 수정.
2. **[완료] 검증 테스트(Vitest) 강화**:
   - `src/server/task-intake.test.ts`에 `tech-port-01-source-discovery` 팀 작업 시 응답 계약 주입 테스트가 올바르게 동작함을 확인. 빌드 예외 테스트 또한 반영.
3. **[제안] Timeout 및 재시도 캡(Retry Cap) 튜닝**:
   - 1800초(30분) 대기열 타임아웃 방지를 위해, 리서치 전용 워커 노드와 백그라운드 태스크 할당량을 분리하는 큐(queue) 우선순위 전략 도입 검토.

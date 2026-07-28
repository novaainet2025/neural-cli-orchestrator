# Skill Academy and Capability Transfer Failure Patterns (2026-07-28)

## 48h/8 샘플 기반 근본원인 분석
Skill Academy 및 Capability Transfer 과정에서 확인된 에이전트별 실패 패턴과 시스템 한계 분석입니다. 해당 분석은 다음 사이클의 스킬 전이 실패를 방지하기 위한 Mem0 장기 기억소에 등록됩니다.

### 1. Codex (code) 지연 및 대체 패턴
- **분석**: `codex` 프로바이더가 과부하로 인해 큐 대기 타임아웃(`queue_wait_timeout: provider codex busy for 1800000ms`)을 겪는 경우가 빈번함.
- **결과**: `claude-code` 등 대체 에이전트로 reassignment 발생. 이로 인해 최종 성공률이 46.7% 수준으로 하락하며 평균 품질도 낮아짐.
- **수정/우회 방안**: 스킬 전이 작업 시 `codex` 프로바이더 할당 시 타임아웃을 조기에 감지하고 Failover를 빠르게 수행하도록 워크플로 개선 필요.

### 2. Hermes 역할별 0% 성공 패턴
- **분석**: `hermes` 에이전트가 code, design, research, review, verify 모든 역할에서 실행 시도 후 0% 성공률 기록.
- **결과**: 실제 검증 가능한 로그가 부족하거나 작업 자체가 완료되지 못함.
- **수정/우회 방안**: 단기적으로 `hermes` 에이전트의 스킬 전이 할당을 회피하거나, 해당 에이전트 환경의 샌드박스 로그 복구 조치.

### 3. 단일 표본(n=1) 스코어 한계 (정상 동작)
- **분석**: `team_gov-evolution-skills`의 작업 표본이 `all/1`인 경우, 팀 스코어러 로직 `computeVolume(1, maxN)`이 `log10(1)=0`이 되어 90점 상한에 도달.
- **결과**: 오류나 결함이 아닌 스코어러의 정상적인 설계(볼륨 서브스코어 페널티) 동작임.

### 4. 인프라 결함 (Orphaned Tasks & EPERM)
- **분석**: 서버 재시작 시 작업이 orphaned 상태가 되며 독성 메시지로 판별되어 실패(`poison — requeued 2x`). 또한 읽기 전용 파일 시스템 제약으로 인해 Obsidian 작성 및 임시 파일(`node_modules/.vite-temp/...`) 생성이 EPERM 오류로 차단됨.
- **결과**: 검증 실패 및 산출물 손실.
- **수정/우회 방안**: 파일 쓰기 필요 시 권한이 확보된 특정 임시 경로를 활용하거나, 인프라의 Read-only 제약을 감안한 Graceful Degradation(대체 로깅) 적용.

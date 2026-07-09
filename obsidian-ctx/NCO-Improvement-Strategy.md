## 현재 상태 진단
- 전체 작업 100개 중 90개 완료, 성공률 90%.
- 실패 1건, 진행 중(멈춤) 3건.
- False report count 6회 (보고 정확도 이슈).
- Obsidian 문서 7019개, 개선 노트 849개 포착.

## 핵심 개선 목표 (3가지)
1. **작업 성공률 및 스루풋 향상** – 실패·멈춤 작업 감소.
2. **보고 정확도 강화** – False report 횟수 최소화.
3. **자동화 및 메트릭 표준화** – 개선 노트 활용과 사이클 측정 자동화.

## 구체적 실행 계획 (각 목표별)
### 1. 작업 성공률 및 스루풋 향상
- **원인 분석**: `src/core/*`에서 타임아웃 및 리소스 제한 로그 확인.
- **액션**:
  - 리소스 제한 파라미터(예: `maxConcurrentTasks`) 상향.
  - 멈춤 작업 자동 재시도 로직 추가 (`TaskScheduler.retryStuckTasks`).
  - 실패 작업에 대한 상세 오류 로깅 및 알림 강화.
- **완료 기준**: 실패 ≤0.5%, 멈춤 ≤1% 달성.

### 2. 보고 정확도 강화
- **원인**: False report count는 검증 절차 부재와 T4 수준 보고에 기인.
- **액션**:
  - 모든 중요한 상태 변화에 T1 검증(파일/DB 확인) 구현 (`VerificationEngine`).
  - `NCO_FALSE_REPORT_MODE`를 `block`으로 전환, 자동 검증 실패 시 작업 중단.
  - 기존 보고 템플릿에 검증 영수증 섹션 추가.
- **완료 기준**: False report count 0 유지 (연속 2 사이클).

### 3. 자동화 및 메트릭 표준화
- **액션**:
  - 매 사이클 종료 시 `npm run test:run` 및 메트릭 스크립트 실행 (`scripts/collect-metrics.ts`).
  - 메트릭을 Obsidian vault에 자동 기록 (`obsidian-watcher.ts` 활용).
  - CI 파이프라인에 메트릭 대시보드 적용.
- **완료 기준**: 메트릭 자동 수집 및 문서화 100% 구현.

## 자동화 가능한 부분
- **작업 재시도**: `TaskScheduler`에 재시도 정책 자동 적용.
- **보고 영수증 생성**: `VerificationEngine`이 T1 검증 후 마크다운 템플릿 자동 작성.
- **메트릭 수집**: `scripts/collect-metrics.ts`를 cron 혹은 NCO 이벤트 루프에 연동.
- **Obsidian 동기화**: `obsidian-watcher.ts`를 통해 새 메트릭 파일 자동 커밋·push.

## 다음 사이클 측정 지표
- `tasks_total`, `tasks_completed`, `tasks_failed`, `tasks_stuck` 비율.
- `success_rate` 목표 ≥ 95%.
- `false_report_count` = 0.
- 자동 수집된 메트릭 파일 수 및 최신 업데이트 시각.
- 개선 노트 생성 속도(노트당 평균 소요 시간) ≤ 2분.

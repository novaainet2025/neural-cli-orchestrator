## 현재 상태 진단
- 총 작업 100건 중 98건 성공, 2건 진행 중(stuck) → 성공률 98.0%
- `false_report_count` 34회 (잘못된 성공 보고) → 신뢰성 저하 위험
- Obsidian 문서 수: 5,800개, 개선 노트: 751개 → 방대한 지식 베이스지만 정리·활용 필요

## 핵심 개선 목표 (3가지)
1. **스테일(정체) 작업 감소 및 자동 해제**
2. **false report 정확도 향상 및 검증 체계 강화**
3. **Obsidian 지식 베이스와 자동 연동 효율화**

## 구체적 실행 계획 (각 목표별)
### 목표 1 – 스테일 작업 감소
- 작업 큐 모니터링 주기 단축: `src/core/eventBus.ts` 타이머를 60 s → 15 s 로 조정.
- 타임아웃 기반 자동 재시도 로직 추가 (`src/agent/OrchestratedLoop.ts`): 최대 3회 재시도, 지수 백오프 적용.
- 정체 감지 알림 설정: `config/alerts.json`에 Slack/Webhook 연동, 정체 감지 시 알림 전송.

### 목표 2 – false report 정확도 향상
- 성공 보고 검증 단계 도입: 작업 완료 시 결과 검증용 체크섬/해시 저장 및 비교.
- `src/core/validation.ts` 신규 모듈 추가, `validateResult(result): boolean` 구현.
- 검증 실패 시 자동 롤백 및 재시도 로그 기록.
- false report 카운터 검증 자동화: `src/utils/metrics.ts`에 집계 로직 강화.

### 목표 3 – Obsidian 연동 효율화
- Obsidian 문서 자동 인덱싱 스크립트 (`scripts/obsidian-index.ts`) 개발, 매일 실행하도록 cron 설정.
- 개선 노트와 작업 ID 매핑 DB(`src/storage/obsidianSync.ts`) 추가, 작업 완료 시 자동 링크 생성.
- 불필요한 중복 문서 정리 정책 정의 및 자동 실행 (`scripts/obsidian-cleanup.ts`).

## 자동화 가능한 부분
- **작업 큐 모니터링 주기 및 정체 감지**: `eventBus` 타이머 조정 자동 적용 스크립트.
- **재시도·검증 로직**: `OrchestratedLoop`에 재시도와 검증 함수 자동 삽입.
- **Obsidian 인덱스·링크 자동 생성**: CI 파이프라인에 `npm run obsidian-sync` 추가.
- **메트릭 집계 및 보고**: `metrics.ts`에서 매일/주간 보고서 생성 후 Slack 전송.

## 다음 사이클 측정 지표
- **스테일 작업 비율**: `tasks_stuck / tasks_total` 목표 < 0.5% (현재 2%).
- **false report 감소율**: `false_report_count`를 전 사이클 대비 30% 감소 목표.
- **Obsidian 연동 성공률**: 자동 생성된 작업‑문서 링크 비율 90% 이상 달성.
- **전체 성공률**: `success_rate` 99.5% 이상 유지.
- **자동화 커버리지**: 신규 자동화 스크립트 커버률 80% 이상.

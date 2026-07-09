## 현재 상태 진단
- 전체 작업 100개 중 98개 완료, 성공률 98%.
- 실패 작업 0개, 정체 작업 2개 존재.
- False report count 9회: 검증 누락 가능성.
- Obsidian 문서 4,378개, 개선 메모 639개: 문서 관리·검색 비용 상승.

## 핵심 개선 목표 (3가지)
1. **False Report 정확도 강화** – 보고 체계 자동 검증 및 알림.
2. **문서·노트 관리 최적화** – 메타데이터 자동화, 중복 정리, 검색 효율화.
3. **지속 가능한 성능 모니터링** – 자동 메트릭 수집·대시보드 구축.

## 구체적 실행 계획 (각 목표별)
### 1. False Report 정확도 강화
- `false_report` 로그를 구조화 JSON 형태로 기록.
- `NCO_FALSE_REPORT_MODE` 환경변수 확대 적용, 자동 Slack/Webhook 알림 연동.
- 사이클 종료 시 `npm run verify-false-reports` 스크립트 실행 자동화.
- 검증 단계에서 T1 로그(`cat false_reports.log`)를 CI에 추가.

### 2. 문서·노트 관리 최적화
- Obsidian 문서 메타데이터 자동 삽입 스크립트(`obsidian-meta-sync.sh`) 구축.
- 중복 문서 탐지 및 정리 파이프라인 (`npm run obsidian-dedupe`).
- 검색 인덱스 재구축 자동화 (`npm run obsidian-index`).
- 개선 메모를 태그 기반 뷰로 전환하여 가시성 향상.

### 3. 지속 가능한 성능 모니터링
- 메트릭 수집 에이전트(`nco-metrics.ts`)에 성공률, 실패, false report 등 주요 지표 기록.
- Grafana 대시보드와 연동해 실시간 시각화.
- 매 사이클 종료 시 `npm run metrics-report` 실행하여 요약 리포트 생성.
- 알림 임계치 설정: success_rate < 98% 또는 false_report_count > 5시 Slack 경고.

## 자동화 가능한 부분
- **로그 구조화 및 검증**: `npm run verify-false-reports` (CI 자동 실행).
- **문서 메타데이터 동기화**: `obsidian-meta-sync.sh` (Git hook 또는 cron).
- **중복 문서 정리**: `npm run obsidian-dedupe` (PR 자동 생성).
- **메트릭 수집·대시보드 업데이트**: `nco-metrics.ts` + Grafana 자동 리로드.
- **주요 지표 알림**: 환경변수 기반 Slack/Webhook 자동 전송.

## 다음 사이클 측정 지표
- **성공률**: 목표 ≥ 99%.
- **False report count**: 목표 ≤ 2.
- **Obsidian 문서 수**: 정리 후 5% 감소 목표.
- **Improvement notes 처리율**: 80% 이상 완료.
- **자동화 스크립트 실행 성공률**: 100% (CI 통과).
## 현재 상태 진단
- **전체 과제**: 100개 모두 완료, 실패 0, 정체 0, 성공률 100%
- **거짓 보고 횟수**: 8회 – 보고의 신뢰성 검증 필요
- **Obsidian 문서**: 7,350개, 개선 노트 875개 – 문서 관리 및 검색 부담 존재

## 핵심 개선 목표 (3가지)
1. **거짓 보고 감소 및 검증 체계 강화**
2. **문서/노트 관리 자동화 및 검색 효율화**
3. **시스템 메트릭 지속 모니터링 및 피드백 루프 고도화**

## 구체적 실행 계획
### 목표 1: 거짓 보고 감소 및 검증 체계 강화
- **워크플로우 도입**: 모든 자동 보고에 T1 증거(파일/DB 상태) 첨부하도록 `src/utils/validation.ts`에 `assertTruth` 헬퍼 추가
- **메트릭 기록**: `false_report_count`를 `metrics` 테이블에 저장, 사이클 별 알림 트리거
- **주간 리뷰**: `cursor-agent` 활용 자동 리뷰, 이상치 감지 시 알림

### 목표 2: 문서/노트 관리 자동화 및 검색 효율화
- **폴더 정규화**: Obsidian vault 내 개선 노트 폴더 구조 표준화 (`Improvement/Notes/YYYY-MM-DD.md`)
- **메타데이터 자동 삽입**: 노트 생성 시 태그(`#improvement`, `#nco`)와 요약 자동 추가 스크립트(`obsidian-ctx/obsidian-context-builder.sh`) 연동
- **검색 인덱스**: 기존 `obsidian-watcher.ts`에 ElasticSearch 연동 혹은 `ripgrep` 기반 인덱스 구축으로 빠른 검색 구현

### 목표 3: 시스템 메트릭 지속 모니터링 및 피드백 루프 고도화
- **실시간 대시보드**: `src/server/monitor.ts`에 메트릭 시각화 추가 (Grafana UI 또는 간단 HTML)
- **피드백 루프**: 주요 지표 변화 감지 시 자동 `cursor-agent` 리뷰 요청 생성
- **알림 시스템**: Slack/Webhook 연동을 통한 주간/월간 요약 전송

## 자동화 가능한 부분
- **보고 검증 자동화**: `assertTruth` 헬퍼와 pre-commit hook 연계
- **노트 템플릿 자동 생성**: `obsidian-context-builder.sh` 스크립트에 날짜 기반 파일 생성 로직 추가
- **메트릭 수집 파이프라인**: `src/utils/metrics.ts`에 Prometheus exporter 구현
- **알림 트리거**: `src/core/eventBus.ts`에서 특정 메트릭 임계치 초과 시 Slack webhook 호출 자동화

## 다음 사이클 측정 지표
- **거짓 보고 감소율**: 목표 50% 감소 (4회 이하) 달성 여부
- **문서 검색 평균 응답 시간**: 200ms 이하 유지
- **실시간 메트릭 대시보드 가동률**: 100% 가동, 오류 없음
- **자동 알림 정확도**: 오탐률 5% 이하
- **전체 시스템 성공률**: 100% 유지

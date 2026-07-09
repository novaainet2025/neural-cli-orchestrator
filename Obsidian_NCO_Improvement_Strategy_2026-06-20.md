## 현재 상태 진단
- `tasks_total`: 100
- `tasks_completed`: 96
- `tasks_failed`: 0
- `tasks_stuck`: 4
- `success_rate`: 96.0 %
- `false_report_count`: 15
- `obsidian_docs`: 8,256
- `improvement_notes`: 920

## 핵심 개선 목표 (3가지)
1. **거짓 보고(false report) 감소** – 오탐을 줄이고 알림 신뢰성 향상
2. **작업 정체(stuck) 감지 및 자동 회복** – 정체 작업을 조기에 탐지하고 재시도 자동화
3. **문서·노트 활용도 증대** – Obsidian 메타데이터 자동 추출·태깅·검색 최적화

## 구체적 실행 계획 (각 목표별)
### 1. 거짓 보고 감소
- false_report_count 알림 로직 재검토 및 임계값 조정
- 과거 오탐 로그 수집 → 머신러닝 기반 오탐 예측 모델 구축
- 사용자 피드백 인터페이스 추가
### 2. 작업 정체 감지 및 자동 회복
- 작업 상태 주기적 Heartbeat 기록 (Redis TTL) 도입
- `tasks_stuck` > 0 감지 시 자동 재시도 워커 스케줄링
- 정체 원인 로그(예: DB lock, 외부 API 지연) 자동 수집
### 3. 문서·노트 활용도 증대
- Obsidian 파일 메타데이터(태그, 생성/수정 시간) 자동 삽입 스크립트
- 주요 지표(성공률, false_report)와 연결된 노트 자동 업데이트
- 검색 인덱스 재구축 파이프라인 구축 (weekly)

## 자동화 가능한 부분
- **정체 작업 자동 재시도**: 워커 → Redis 스케줄러
- **거짓 보고 모델 학습 파이프라인**: Nightly CI → 모델 배포
- **Obsidian 메타데이터 삽입**: 파일 저장 시 Hook 스크립트
- **지표 대시보드 업데이트**: Grafana → Prometheus exporter 자동 푸시

## 다음 사이클 측정 지표
- `false_report_count` 감소 비율 (목표: 30% 감소)
- `tasks_stuck` 평균 해결 시간 (목표: < 5분)
- 문서 자동 태깅 비율 (목표: 90% 이상 적용)
- 자동 재시도 성공률 (목표: 95% 이상)
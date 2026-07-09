---
created_at: 2026-06-26T13:45:11.715Z
updated_at: 2026-06-26T14:08:54.124Z
tags:
  - improvement
  - improvement-note
---
## 현재 상태 진단
- 전체 작업 100개 중 98개 성공, 1개 실패, 1개 정체 → 성공률 98%
- 허위 완료 보고 12건 (실제 완료 86% 수준) → 신뢰성 문제
- Obsidian 문서 9,842건, 개선 노트 977건 – 검색·정비 비용 증가
- 주요 병목: 실패 원인 자동 분석 부족, 허위 보고 검증 미비, 메트릭·리포팅 자동화 부재

## 핵심 개선 목표 (3가지)
1. **허위 보고 방지 및 검증 강화** – T1/T2/T3 증거 기반 완료 승인 프로세스 도입
2. **실패·정체 원인 자동 분석 및 회복** – 자동 로그 수집·원인 추론 및 재시도 메커니즘 구축
3. **메트릭·리포팅 자동화 파이프라인 구축** – 실시간 대시보드와 사이클 별 KPI 보고 자동화

## 구체적 실행 계획 (각 목표별)
### 목표 1 – 허위 보고 방지 및 검증 강화
- `nco_task ollama` 로 모든 작업 결과를 T1 증거(HTTP 응답, 파일 존재, exit code)와 함께 저장
- 검증 영수증(`## 검증 영수증`) 형식 표준화 및 자동 기록 로직 추가
- 허위 보고 감지 시 `false_report_count` 자동 증가 및 `tasks_completed`에서 제외
- 기존 파이프라인에 검증 단계 삽입 (pre‑commit hook 형태)

### 목표 2 – 실패·정체 자동 분석 및 회복
- 작업 종료 시 로그/메트릭을 SQLite·Redis에 저장하도록 `EventBus` 강화
- `ollama` 기반 원인 분석 프롬프트 자동 호출 → 원인 요약 저장
- 재시도 정책 추가: 실패 시 3회 재시도, 정체 시 타임아웃 후 알림
- 자동 복구 스크립트(`src/core/recovery.ts`) 구현 및 테스트

## 자동화 가능한 부분
- **검증 영수증 자동 생성** – `src/utils/validationReceipt.ts` 모듈화
- **실패 원인 자동 분석** – `src/core/failureAnalyzer.ts` (ollama 호출 래핑)
- **메트릭 수집·노출** – `src/monitoring/prometheus.ts` 및 `src/monitoring/grafana.ts`
- **주기적 리포트 작성** – `scripts/generate_cycle_report.sh` (GitHub Actions 연계)
- **Obsidian 자동 커밋** – `scripts/obsidian_sync.sh` (자동 푸시)

## 다음 사이클 측정 지표
- 허위 보고 비율 ≤ 2% (false_report_count / tasks_total)
- 평균 태스크 회복 시간 ≤ 30초
- 성공률 (실제 검증 완료) ≥ 95%
- 메트릭 수집 커버리지 100% (모든 주요 이벤트 Prometheus에 기록)
- 자동 리포트 생성 성공률 100% (CI 빌드 성공 시 포함)
- 전체 작업 100개 중 99개 성공, 1개 실패, 성공률 99%\n- 거짓 보고 횟수 10회 (false_report_count)\n- Obsidian 문서 9,828개, 개선 노트 976개\n- 주요 병목: 실패 원인 분석 부족, 거짓 보고 검증 미비, 자동화된 메트릭 수집 부재\n\n## 핵심 개선 목표 (3가지)\n1. **거짓 보고 방지 및 검증 강화**\n2. **실패 원인 자동 분석 및 회복**\n3. **자동화된 메트릭 수집·리포팅 파이프라인 구축**\n\n## 구체적 실행 계획 (각 목표별)\n### 목표 1: 거짓 보고 방지 및 검증 강화\n- 기존 검증 영수증 프로세스 T1/T2/T3 규격 전면 적용\n- `nco_task ollama` 사용해 작업 결과를 HTTP/파일 T1 증거와 함께 저장\n- 거짓 보고 감지 시 자동 `false_report_count` 증가 및 알림 (Slack/Webhook)\n- 매주 거짓 보고 로그를 검토하는 자동 스케줄러 추가\n\n### 목표 2: 실패 원인 자동 분석 및 회복\n- `nco_task codex` 로 실패 작업 재시도 자동화 (exponential backoff)\n- 실패 시 `cursor-agent` 로 보안·코드 리뷰 트리거\n- 실패 로그를 `gbrain`에 인덱스해 유사 이슈 자동 검색·제안\n- 회복 성공률 90% 목표, 회복 실패 시 수동 알림\n\n### 목표 3: 자동화된 메트릭 수집·리포팅 파이프라인 구축\n- Prometheus exporter 모듈 `src/metrics/nco_exporter.ts` 추가\n- 주요 메트릭: tasks_total, tasks_completed, tasks_failed, false_report_count, avg_cycle_time\n- Grafana 대시보드 템플릿 자동 생성 (JSON)\n- 매 사이클 말미 `nco_task ollama` 로 리포트 markdown 자동 생성 및 Obsidian vault에 저장\n\n## 자동화 가능한 부분\n- **작업 완료 검증**: `nco_task ollama` 로 HTTP 응답·파일 해시 T1 검증 자동화\n- **거짓 보고 감지**: 스크립트 `scripts/detect_false_reports.sh` 로 로그 파싱·카운트 증가\n- **실패 복구**: `scripts/auto_recover_failed.sh` 가 실패 작업 재시도 및 로그 남김\n- **메트릭 수집**: `src/metrics/collector.ts` 에서 1분 간격 수집, `prometheus-node-exporter` 로 노출\n- **리포트 작성**: `scripts/generate_cycle_report.ts` 가 markdown 템플릿에 현재 메트릭을 채워 Obsidian에 커밋\n\n## 다음 사이클 측정 지표\n- 거짓 보고 감소율 (목표: 30% 감소)\n- 평균 복구 시간 (MTTR) ≤ 5분\n- 자동 메트릭 수집 커버리지 100%\n- 성공률 유지 ≥ 99%\n- 신규 자동 리포트 생성 건수 ≥ 1건/사이클
## 현재 상태 진단
- **전체 과제**: 100개 모두 완료, 실패 0, 정체 0, 성공률 100%
- **오류 보고**: false_report_count 8 (거짓 보고 기록) → 검증 프로세스 강화 필요
- **문서 현황**: Obsidian에 7,210개 문서, 개선 노트 866개 보유 (지식 베이스 풍부하지만 관리 필요)

## 핵심 개선 목표 (3가지)
1. **거짓 보고 방지 및 검증 정확도 상승**
2. **문서·노트 자동화 및 품질 관리**
3. **자율 학습 루프 가시성 및 메트릭스 정량화**

## 구체적 실행 계획
### 목표 1: 거짓 보고 방지
- **1.1 검증 레이어 추가**: 모든 작업 결과에 T1 검증(파일/DB/HTTP) 자동 삽입
- **1.2 false_report 카운터 모니터링**: 매 사이클 `false_report_count` > 5 시 알림 및 자동 롤백 트리거
- **1.3 리뷰 프로세스 강화**: cursor‑agent 리뷰 단계에서 `## 검증 영수증` 템플릿 의무화

### 목표 2: 문서·노트 자동화
- **2.1 Obsidian 스크립트**: `nco_tool` 로 `obsidian_sync` 명령 구현 → 새 개선 노트 자동 생성/태깅
- **2.2 중복·오래된 노트 정리**: 매주 `improvement_notes` 에서 사용되지 않은 노트 30일 이상 삭제
- **2.3 메타데이터 표준화**: 각 노트에 `status: pending|in_progress|completed` 필드 추가

### 목표 3: 자율 학습 루프 가시성
- **3.1 메트릭 대시보드**: `/metrics` 엔드포인트에 `tasks_total`, `tasks_completed`, `false_report_count`, `improvement_notes` 등 실시간 JSON 제공
- **3.2 사이클 리뷰 템플릿**: 매 사이클 끝에 자동 생성되는 `Cycle Review` 문서에 KPI 대비 차이 기록
- **3.3 피드백 루프**: `ollama` 검증 결과를 `improvement_notes`에 자동 회수해 학습 데이터베이스에 반영

## 자동화 가능한 부분
- **작업 결과 검증** → `nco_task ollama` 실행 후 T1 검증 스크립트 자동 호출
- **Obsidian 노트 생성·태깅** → `bash cli-installs/obsidian-sync.sh` (가정) 로 파일 시스템에 마크다운 저장
- **KPI 수집·보고** → `cron` 으로 `curl http://localhost:6200/metrics > ./metrics/latest.json`
- **거짓 보고 알림** → `watchdog` 스스크립트가 `false_report_count` 변동 시 Slack/Webhook 전송

## 다음 사이클 측정 지표
- **false_report_count** ≤ 2
- **improvement_notes** 신규 100개 이상 생성, 기존 90% 이상 최신 상태 유지
- **자동 검증 성공률** (T1 검증 통과) ≥ 98%
- **대시보드 응답 시간** ≤ 200 ms
- **문서 정리 비율**: 오래된 노트 30일 이상 삭제 비율 ≥ 80%
## 현재 상태 진단
- 총 작업 100건, 모두 성공적으로 완료됨. 실패 및 정체 상태 없음.
- 성공률 100%이지만 `false_report_count`가 11건으로 잘못된 성공 보고가 존재함.
- Obsidian 문서 8,107개, 개선 노트 907개가 누적되어 관리 부담이 커짐.

## 핵심 개선 목표 (3가지)
1. **거짓 보고(false report) 정확도 개선** – 잘못된 성공 보고를 감소시켜 신뢰성 확보.
2. **Obsidian 문서 관리 자동화** – 문서 증가에 따른 인덱싱·정리 자동화.
3. **개선 노트 피드백 루프 강화** – 노트에서 제안된 개선 사항을 자동 추적·실행.

## 구체적 실행 계획
### 목표 1: 거짓 보고 정확도 개선
- `src/utils/falseReportTracker.ts`에 실제 작업 결과와 보고를 교차 검증하는 로직 추가.
- 작업 완료 후 `reportSuccess()` 호출 시 실제 DB/Redis 상태를 확인하고 불일치 시 경고 및 재시도.
- 매일 `false_report_count` 모니터링용 Cron 작업 추가 (`src/cron/falseReportMonitor.ts`).

### 목표 2: Obsidian 문서 관리 자동화
- `obsidian-ctx/obsidian-watcher.sh`에 새 문서 감지 시 자동 메타데이터(`tags`, `created`) 삽입 스크립트 구현.
- 월간 인덱스 파일(`Obsidian_Index_YYYYMM.md`) 자동 생성·업데이트 로직 추가 (`src/obsidian/indexGenerator.ts`).
- 오래된/중복 문서 자동 아카이브 기능 구현 (30일 이상 미사용 시 `archive/` 이동).

### 목표 3: 개선 노트 피드백 루프 강화
- `src/core/improvementEngine.ts`에 개선 노트(`improvement_notes`)와 실제 실행 결과 매핑 DB 테이블 추가.
- 노트 작성 시 자동 UUID 부여 및 해당 UUID를 `tasks` 메타에 기록.
- 주간 리포트(`src/cron/improvementReport.ts`)에서 미반영 노트 자동 알림.

## 자동화 가능한 부분
- **거짓 보고 감시**: Cron + 이벤트 기반 알림 (T1 검증). 
- **Obsidian 인덱스·아카이브**: 파일 시스템 감시(`fs.watch`)와 스크립트 자동 실행. 
- **개선 노트 트래킹**: DB 트리거와 주간 리포팅 자동화.

## 다음 사이클 측정 지표
- `false_report_count` ≤ 2건 (목표: 80% 감소).
- 신규 Obsidian 문서 자동 메타데이터 적용 비율 95% 이상.
- 개선 노트 중 실행된 비율 ≥ 70%.
- 전체 작업 성공률 유지 (≥99.5%).

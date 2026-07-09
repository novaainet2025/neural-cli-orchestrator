## 현재 상태 진단
- **전체 작업**: 100건 (완료 96건, 정체 4건, 성공률 96 %)
- **허위 보고**: 1건 (전체 대비 1 %) → 실제 검증 통과율 약 95 %
- **Obsidian 문서**: 4,912개
- **개선 노트**: 687개 (백로그 비중 약 14 %)

## 핵심 개선 목표 (3가지)
1. **보고 정확성 향상** – false report 감소 및 검증 체계 강화
2. **백로그 실행률 강화** – 개선 노트 자동 트리거 및 우선순위 재조정
3. **지식베이스 최적화** – 중복·노이즈 감소와 검색·연계 효율 향상

## 구체적 실행 계획
### 목표 1: 보고 정확성 향상
- **T1 검증 파이프라인**: 작업 완료 전 `file_exists`, `test_pass`, `shell_success` 등 최소 두 가지 실체 검증을 필수화
- **에이전트 신뢰 점수**: false report 발생 시 에이전트 신뢰도 감소, 신뢰도 하락 시 작업 할당 제한
- **자동 감사 스크립트**: `scripts/false_report_audit.ts` 로 기존 false report 사례 수집·분류, 월간 보고

### 목표 2: 백로그 실행률 강화
- **개선 노트 메타데이터**: `#improvement` 태그와 `status: pending|in_progress|done` 필드 추가
- **우선순위 모델**: 영향도·긴급도 기반 스코어링, 상위 N건 자동 `nco_task` 트리거 (주간 실행)
- **자동 리마인더**: 정해진 기간 내 해결되지 않으면 Slack/Discord 알림

### 목표 3: 지식베이스 최적화
- **중복 탐지**: `scripts/obsidian_dupes.ts` 로 유사 문서 자동 검출 후 병합 제안
- **노이즈 태깅**: 저활용 문서에 `#archived` 자동 부착 및 별도 보관
- **검색 인덱스 강화**: `obsidianSync.ts` 에 Elasticsearch 연동, 키워드 가중치 조정

## 자동화 가능한 부분
- **CI 검증**: `gemma-gate-check` 와 연동한 검증 영수증 자동 검사
- **개선 노트 트리거**: `nco_task` 를 활용한 주간 자동 실행 스케터
- **문서 동기화**: 파일 시스템 변화 감시(`fswatch`) → DB/검색 엔진 업데이트
- **리포트 생성**: `npm run generate-improvement-report` 로 KPI 자동 집계 및 Obsidian에 삽입

## 다음 사이클 측정 지표
- **false_report_rate** ≤ 0.5 % (목표 0.5 % 이하)
- **stuck_tasks** = 0
- **improvement_note_processed_rate** ≥ 80 % (처리된 개선 노트 비율)
- **doc_sync_latency** ≤ 5분 (문서 DB 반영 평균 시간)
- **overall_success_rate** 유지 ≥ 96 %
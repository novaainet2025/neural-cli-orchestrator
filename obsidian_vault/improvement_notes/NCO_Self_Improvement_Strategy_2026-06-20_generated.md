---
created_at: 2026-06-17T21:53:16.334Z
updated_at: 2026-06-20T14:19:42.190Z
tags:
  - improvement
  - improvement-note
---
## 현재 상태 진단
- 전체 작업 100개 중 99개 완료, 1개 정체(stuck) → 성공률 99%
- 실패 작업 0개, 즉각적인 오류는 없음
- `false_report_count` 22건: 보고된 허위 보고가 존재, 자동 보고 정확도 개선 필요
- Obsidian 문서 8,429개, 개선 노트 932개 누적 → 방대한 지식 베이스 관리 부담

## 핵심 개선 목표 (3가지)
1. **작업 정체 해소 및 성공률 99% 이상 달성**
2. **허위 보고(false report) 감소 및 보고 정확도 향상**
3. **지식 베이스(Obsidian) 관리 자동화 및 노트 품질 향상**

## 구체적 실행 계획
### 목표 1: 작업 정체 해소
- **모니터링 강화**: 작업 진행 상태를 30초 간격으로 체크하는 watchdog 추가 (Redis TTL 활용)
- **재시도 로직**: `tasks_stuck` 발생 시 자동 재시도 로직 구현 (max 3 retries, exponential backoff)
- **우선순위 재조정**: 정체된 작업을 `high` priority 로 전환하여 이벤트 버스에 재배치
- **검증**: 매 사이클 종료 후 `tasks_stuck` 수치와 성공률을 로그에 기록, CI 테스트에 포함

### 목표 2: 허위 보고 감소
- **신뢰도 스코어링**: 각 에이전트별 보고 신뢰도 점수 (`reportScore`) 도입, 낮은 점수는 검토 대상
- **二段 검증**: 중요한 보고는 `ollama` 검증 단계 추가 (T1: 실제 DB/파일 상태와 비교)
- **피드백 루프**: 허위 보고가 확인되면 해당 에이전트의 `reportScore` 감소 및 재학습 트리거
- **데이터 시각화**: 대시보드에 `false_report_count` 추이 그래프 추가

### 목표 3: Obsidian 지식 베이스 자동화
- **문서 메타 자동 태깅**: 새 노트 생성 시 `tags` 필드에 자동으로 `#generated #cycle2026-06` 삽입
- **중복 검출**: `rg` 기반 텍스트 유사도 검사로 중복 노트 90% 이상 자동 병합
- **주기적 정리**: 매 주 `npm run prune:obsidian` 스크립트 실행 → 오래된 초안 삭제, 오래된 개선 노트 아카이브
- **검색 최적화**: `gbrain` 연동으로 노트 검색 속도 향상 (BM25 + 벡터 검색)

## 자동화 가능한 부분
- **Watchdog & 재시도**: 백그라운드 서비스 (`src/core/taskWatchdog.ts`) 자동 실행
- **보고 신뢰도 점수 업데이트**: `src/agent/reportProcessor.ts`에서 자동 점수 조정 로직
- **Obsidian 정리 스크립트**: `scripts/obsidian-prune.sh` 배포, CI 파이프라인에 포함
- **대시보드 업데이트**: `src/server/dashboard.ts`에 실시간 그래프 위젯 추가 (Grafana와 연동)

## 다음 사이클 측정 지표
- `tasks_stuck` ≤ 1
- `success_rate` ≥ 99.0%
- `false_report_count` 감소 30% 목표 (현재 22 → ≤ 15)
- Obsidian 문서 중 `#generated` 태그 비율 ≥ 70%
- 중복 노트 비율 ≤ 5%
- 자동 정리 스크립트 성공률 100% (CI 로그로 검증)
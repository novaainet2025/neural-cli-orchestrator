---
created_at: 2026-06-21T06:17:48.578Z
updated_at: 2026-06-21T13:25:46.338Z
tags:
  - improvement
  - improvement-note
---
## 현재 상태 진단
- 전체 태스크 100개 중 98개 완료, 성공률 98%
- 스틱된 태스크 2개 존재, 시스템 응답 지연 가능성
- False report count 35회 (보고 정확도 검증 필요)
- Obsidian 문서 8,806개, 개선 노트 949개 누적

## 핵심 개선 목표 (3가지)
1. **태스크 스틱 현상 최소화** – 스틱된 태스크 자동 탐지 및 재시도 메커니즘 구축
2. **보고 정확도 향상** – False report 검증 및 자동 교정 파이프라인 구현
3. **지식 베이스 자동화** – Obsidian 문서와 개선 노트 동기화 및 메타데이터 자동 생성

## 구체적 실행 계획 (각 목표별)
### 1. 태스크 스틱 최소화
- 스틱 감지: `tasks_stuck` > 0 시 Redis 이벤트 `task:stuck` 발행
- 자동 재시도 워커: 30초 간격으로 해당 태스크 상태 조회 후 재시도 혹은 알림
- 모니터링 대시보드에 스틱 태스크 수 실시간 차트 추가

### 2. 보고 정확도 향상
- False report 로그 수집 스키마 확장 (`false_report_detail`)
- 매 사이클 후 `ollama` 검증 단계에서 보고서와 실제 결과 비교 자동화
- 차이 발생 시 자동 티켓 생성 및 담당자 알림 (Slack/WebHook)

### 3. 지식 베이스 자동화
- Obsidian 문서 생성 시 메타필드(`last_updated`, `tags`) 자동 삽입 스크립트 (`nco-tool obsidian-sync`)
- 개선 노트(`improvement_notes`)와 연계하여 해당 문서 자동 링크 생성
- 주간 `git diff` 기반 변경 사항 요약 자동 생성 및 Obsidian에 기록

## 자동화 가능한 부분
- **스틱 태스크 재시도**: 기존 `src/core/eventBus.ts`에 워커 로직 추가 (Node cron).
- **False report 검증**: `src/agent/monitor.ts`에 검증 플러그인 연결.
- **Obsidian 동기화**: 신규 `src/mcp/obsidianSync.ts` MCP 도구 구현, `nco-tool obsidian-sync` CLI 제공.

## 다음 사이클 측정 지표
- `tasks_stuck` 평균 0.5 이하 유지
- `false_report_count` 20% 감소 목표 (≈28회 이하)
- 자동 동기화된 Obsidian 문서 비율 90% 이상
- 개선 노트 반영 소요 시간 평균 2시간 이하
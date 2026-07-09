---
created_at: 2026-06-18T13:07:38.861Z
updated_at: 2026-06-18T13:07:38.861Z
tags:
  - improvement
  - improvement-note
---
## 현재 상태 진단
- 전체 작업 100건 완료, 성공률 100 %, 정체·실패 없음.
- 거짓 보고(false report) 카운트 **8**회 존재, 검증 정확도 개선 필요.
- Obsidian 문서 **7,197**개, 개선 노트 **865**개 누적, 관리·검색 비용 증가.

## 핵심 개선 목표 (3가지)
1. **거짓 보고 감소** – false report 를 0에 가깝게 축소하고 검증 프로세스 신뢰성 강화.
2. **Obsidian 문서·노트 자동화** – 문서 생성·정리·폐기 파이프라인 구축으로 관리 비용 절감.
3. **지속 가능한 성능 모니터링** – KPI 자동 수집·시각화, 개선 효과 정량화.

## 구체적 실행 계획
### 목표 1: 거짓 보고 감소
- `src/security/falseReportGuard.ts`에 검증 메타데이터 저장 로직 추가.
- 검증 결과를 Redis `nco:false_report` 해시에 기록하고, 일정 기간 내 재검증 시 자동 플래그 해제.
- 매일 `npm run audit:false` 크론 작업으로 false report 현황 리포트 생성 및 슬랙 알림.

### 목표 2: 문서·노트 자동화
- `src/mcp/obsidianSync.ts` 신규 모듈 도입: Git 커밋 후 자동 Obsidian vault 동기화.
- 신규 노트 템플릿 정의 (`templates/improvement_note.md`) 및 `nco_task`를 통해 자동 생성.
- 오래된 노트(30일 미수정) 자동 아카이브 스크립트 (`scripts/archive_obsolete.sh`).

### 목표 3: 성능 모니터링
- Grafana 대시보드에 `false_report_count`, `obsidian_doc_count`, `improvement_note_count` 메트릭 추가.
- `src/metrics/collector.ts`에서 5분마다 메트릭 푸시.
- KPI 정의: false report ≤2, 문서 증가율 ≤5%/주, 노트 아카이브 비율 ≥80%.

## 자동화 가능한 부분
- 검증 메타데이터 기록 → Redis 자동 저장 (코드 레벨).
- 매일 false report 리포트 → Cron + Node 스크립트.
- Obsidian 동기화 및 노트 생성 → MCP + `nco_task`.
- 오래된 노트 아카이브 → Bash 스크립트와 Cron.
- 메트릭 수집 및 대시보드 업데이트 → `metrics` 모듈 자동 실행.

## 다음 사이클 측정 지표
- **False Report Count**: 목표 2 이하.
- **Obsidian Document Count**: 전주 대비 증감률 ≤5%.
- **Improvement Note Count**: 전주 대비 감소율 ≥20% (아카이브 비율).
- **KPI 충족률**: 3가지 목표 중 2개 이상 달성 시 성공.

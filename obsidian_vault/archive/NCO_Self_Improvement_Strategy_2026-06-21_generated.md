---
created_at: 2026-06-17T21:55:26.351Z
updated_at: 2026-06-21T05:00:25.747Z
tags:
  - improvement
  - improvement-note
---
## 현재 상태 진단
- **작업 현황**: 전체 100개의 작업이 모두 완료, 실패 0, 멈춤 0, 성공률 100%
- **오류 보고**: false_report_count = 22 (잘못된 성공/실패 보고 기록)
- **문서 자산**: Obsidian vault에 8,467개의 문서, 개선 노트 932개
- **핵심 문제**: 높은 false report 수치, 자동화된 검증 부족, 개선 노트 관리·활용 효율성 미비

## 핵심 개선 목표 (3가지)
1. **False Report 감소 및 검증 정확성 강화**
2. **개선 노트 자동 수집·분류 파이프라인 구축**
3. **성과 측정 및 피드백 루프 자동화**

## 구체적 실행 계획
### 목표 1: False Report 감소 및 검증 정확성 강화
- **검증 레이어 추가**: `nco_task ollama`를 이용해 모든 작업 완료 후 T1 수준 HTTP/DB 확인 자동화
- **프리핸드쉐이크**: 작업 전 `nco_task opencode` 설계 검증, 작업 후 `nco_task cursor-agent` 리뷰
- **로그 집계**: Redis 이벤트에 `false_report` 플래그 추가, 주기적인 `git log`와 DB 차이점 검증 스크립트 실행

### 목표 2: 개선 노트 자동 수집·분류 파이프라인 구축
- **파일 감시**: Node `chokidar` 로 `obsidian_vault/improvement_notes/*.md` 변동 감지
- **메타데이터 추출**: `gbrain` 검색 엔진 혹은 내부 파서로 태그, 날짜, 담당자 추출
- **인덱스 DB**: SQLite `improvement_notes` 테이블에 자동 INSERT, 검색 API 제공
- **주간 요약**: `nco_task codex` 로 자동 요약 보고서 생성 후 Slack/Webhook 전송

### 목표 3: 성과 측정 및 피드백 루프 자동화
- **KPI 정의**: false_report 비율, 자동 분류 정확도, 노트 활용 빈도
- **대시보드**: Fastify `GET /metrics/improvement` 엔드포인트 구현, Grafana 대시보드 연동
- **피드백 루프**: 매 사이클 말 `nco_task ollama` 로 검증 결과 종합, 개선 아이템 자동 티켓화 (`/api/tasks/create`)

## 자동화 가능한 부분
- 작업 완료 후 자동 검증 (HTTP 상태, DB row) → `nco_task ollama`
- Obsidian 노트 변동 감시 → Node 파일워처 스크립트
- 메타데이터 추출·인덱싱 → `gbrain` 검색 엔진 활용
- 주간 요약·보고서 자동 생성 → `codex` 코드 생성 + `ollama` 검증
- KPI 수집 및 시각화 → Fastify 엔드포인트 + Grafana

## 다음 사이클 측정 지표
| KPI | 현재 | 목표 (다음 사이클) |
|-----|------|-------------------|
| false_report 비율 | 22 / 1000 (예시) | ≤ 5 |
| 자동 검증 적용 비율 | 0% | 100% |
| 개선 노트 자동 분류 정확도 | 0% | ≥ 90% |
| 주간 요약 전송 성공률 | 0% | 100% |
| KPI 대시보드 가용성 | 미구현 | 100% (엔드포인트 + Grafana) |

---
created_at: 2026-06-17T16:42:14.251Z
updated_at: 2026-06-17T20:36:06.044Z
tags:
  - improvement
  - improvement-note
---
## 현재 상태 진단
- **전체 작업**: 100 / 100 완료, 실패 0, 정체 0, 성공률 100%
- **오류 보고 지표**: 현재 `false_report_count` = 34 (거짓 보고 감지 횟수)
- **문서 자산**: Obsidian Vault에 6,051개의 문서가 누적
- **개선 노트**: 775개의 개선 아이디어가 기록됨
- **핵심 문제**: 높은 거짓 보고 횟수와 과도한 문서 규모가 인사이트 도출과 자동화 효율성을 저해함

## 핵심 개선 목표 (3가지)
1. **거짓 보고 감소 및 검증 프로세스 강화**
2. **문서·노트 관리 자동화 및 메타데이터 정비**
3. **성능·가시성 대시보드 구축으로 사이클별 KPI 측정**

## 구체적 실행 계획
### 목표 1: 거짓 보고 감소 및 검증 프로세스 강화
- **1‑1. 검증 로직 표준화**: `src/utils/validation.ts`에 공통 검증 함수 추가 (T1 증거 등급 사용)
- **1‑2. false_report_count 알림**: 매 사이클 종료 시 Slack/Webhook 알림 구현
- **1‑3. 검증 레포트 자동 생성**: `nco_task ollama`를 이용해 검증 요약 보고서 자동 작성

### 목표 2: 문서·노트 관리 자동화 및 메타데이터 정비
- **2‑1. 문서 인덱스 스키마 정의**: `obsidian_vault/improvement_notes/schema.json` 생성 (title, date, tags, status)
- **2‑2. 자동 태깅 파이프라인**: `src/agent/autoTagger.ts` 구현 → 새 노트 생성 시 메타데이터 자동 삽입
- **2‑3. 오래된/중복 노트 정리**: 월간 크론 잡(`npm run prune:obsidian`) 구현, 중복/불필요 문서 자동 아카이브

### 목표 3: 성능·가시성 대시보드 구축
- **3‑1. KPI 정의**: tasks_total, tasks_completed, false_report_rate, docs_per_day, notes_processed 등
- **3‑2. Grafana/Prometheus 연동**: `src/monitor/metrics.ts`에 Prometheus exporter 추가
- **3‑3. 대시보드 템플릿**: `obsidian_vault/improvement_notes/Dashboard.md`에 시각화 마크다운 삽입 (Imgur GIF 혹은 mermaid)

## 자동화 가능한 부분
- **거짓 보고 알림** → HTTP POST webhook 자동화 (curl)
- **노트 메타데이터 삽입** → 파일 생성 시 `git hook` 또는 NCO 에이전트 `autoTagger`
- **중복 정리 스크립트** → `npm run prune:obsidian` (rg + jq)
- **KPI 수집** → Prometheus exporter + Grafana 자동 리로드

## 다음 사이클 측정 지표
| KPI | 현재 | 목표 (다음 사이클) |
|-----|------|-------------------|
| 거짓 보고 비율 | 34 / 100 = 34% | ≤ 10% |
| 신규 문서 증가율 | 6,051 → +150 | ≤ 50 |
| 자동 태깅 적용률 | 0% | ≥ 90% |
| 대시보드 가용성 | 미구현 | 100% (모니터링 UI 제공) |
| 전체 성공률 | 100% | 유지 (≥ 99.5%) |

*이 문서는 Obsidian Vault `improvement_notes` 폴더에 저장됩니다.*
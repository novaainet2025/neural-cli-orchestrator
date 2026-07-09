---
created_at: 2026-06-17T11:25:18.915Z
updated_at: 2026-06-17T17:00:37.642Z
tags:
  - improvement
  - improvement-note
---
## 현재 상태 진단
- **전체 태스크**: 100건 중 100건 완료, 정체 없음(`tasks_stuck` 0).
- **성공률**: 100 % (목표 ≥ 99 %).
- **오류·보고 정확도**: `false_report_count = 34`건 – 실제 오류는 없으나 잘못된 성공·실패 보고가 데이터 신뢰성을 저해.
- **Obsidian 문서**: 5,711개 – 방대한 지식베이스, 검색·연결 효율성 개선 필요.
- **Improvement Notes**: 745건 – 누적된 개선 아이템 관리 및 우선순위 지정 필요.

## 핵심 개선 목표 (3가지)
1. **보고 정확도 향상** – `false_report_count` 감소 및 보고 체계 신뢰성 확보.
2. **지식베이스 효율화** – 문서 검색·연결 최적화 및 자동 메타데이터 생성.
3. **개선 노트 관리 자동화** – 아이템 정렬·우선순위 지정 및 진행 상황 트래킹 자동화.

## 구체적 실행 계획
### 목표 1: 보고 정확도 향상
- **측정 지표**: `false_report_count` 30% 감소 (≤ 24건) 목표.
- **작업**:
  - 기존 보고 로직 audit 및 false positive 원인 파악.
  - 로그 레벨 및 이벤트 필터링 개선.
  - 자동 검증 스크립트(예: `scripts/validate-reports.ts`) 도입.
  - CI에 검증 단계 추가.
### 목표 2: 지식베이스 효율화
- **측정 지표**: 검색 latency 40% 감소, 관련도 점수 평균 ↑10%.
- **작업**:
  - 파일 메타 데이터(태그, 요약) 자동 추출 파이프라인 구축 (`scripts/gen-metadata.ts`).
  - ElasticSearch 혹은 SQLite full‑text 인덱스 적용.
  - Obsidian 플러그인 연동 스크립트 추가.
### 목표 3: 개선 노트 관리 자동화
- **측정 지표**: 월별 처리된 improvement note 수 20% ↑, 백로그 10% 감소.
- **작업**:
  - `improvement_notes` 폴더에 새로운 note 템플릿 적용.
  - 자동 라벨링 및 우선순위 계산 로직(`scripts/triage-notes.ts`).
  - 대시보드 UI에 진행 상황 시각화.

## 자동화 가능한 부분
- 보고 검증 스크립트와 CI 연동 (자동 테스트).
- 메타데이터 생성 파이프라인 (Git hook 혹은 cron).
- 개선 노트 triage 스크립트 (daily cron) 및 대시보드 업데이트.

## 다음 사이클 측정 지표
- `false_report_count` ≤ 24
- 검색 latency ≤ 600 ms (baseline 1 s)
- 월별 처리된 improvement notes ≥ 150건
- 백로그 감소율 ≥ 10%
- 전체 태스크: 100건 중 94건 완료, 6건 정체 (`tasks_stuck = 6`)
- 성공률: 94.0 % (목표 ≥ 99 % 미달)
- 거짓 보고 횟수: 34건 (`false_report_count = 34`)
- Obsidian 문서: 5,646개
- 개선 노트: 744개

## 핵심 개선 목표 (3가지)
1. **정체된 태스크 해소 및 성공률 99 % 이상 달성** – 시스템 가용성 및 처리 효율성 향상.
2. **거짓 보고 감소** – 데이터 신뢰성 확보 및 보고 체계 정밀화.
3. **Obsidian 지식베이스 관리 자동화** – 문서 검색·연결 효율성 및 개선 노트 우선순위 자동화.

## 구체적 실행 계획 (각 목표별)
### 목표 1: 정체된 태스크 해소
- **로그 강화**: `src/core/eventBus.ts`에 태스크 상태 전이 로그 및 메트릭 삽입.
- **재시도 로직**: `src/core/taskRunner.ts`에 지수 백오프와 최대 재시도 카운터 도입.
- **헬스 체크**: `src/agent/OrchestratedLoop.ts`에서 장기 정체 태스크 자동 알림.
- **대시보드**: WebSocket 이벤트를 활용한 실시간 정체 태스크 시각화 추가.

### 목표 2: 거짓 보고 감소
- **검증 파이프라인**: `src/utils/metricsReporter.ts`에서 실제 오류와 보고를 교차 검증.
- **임계값 경고**: `false_report_count`가 20 초과 시 Slack/Email 알림.
- **정책 적용**: 보고 전 Zod 스키마 검증 강화, 불일치 시 자동 보류.
- **가이드 자동 생성**: `src/docs/false_report_guidelines.md` 파일 자동 생성.

### 목표 3: Obsidian 지식베이스 자동화
- **메타데이터 수집**: `scripts/obsidian_sync.ts`에서 문서 메타(태그, 수정일) 추출.
- **우선순위 엔진**: 개선 노트와 메트릭 연계, 높은 영향도 순 정렬.
- **자동 업데이트**: CI 파이프라인에 `npm run obsidian:update` 스크립트 추가, 매일 00:00 실행.
- **검색 인덱스**: Lunr.js 기반 로컬 검색 인덱스 구축, Fastify 엔드포인트 `/obsidian/search` 제공.

## 자동화 가능한 부분
- **태스크 상태 로그/메트릭** → `src/core/eventBus.ts` 자동 삽입.
- **재시도 및 백오프** → `src/core/taskRunner.ts` 구현 자동화.
- **거짓 보고 검증** → `src/utils/metricsReporter.ts`에 검증 로직 추가.
- **알림 및 대시보드** → WebSocket 브리지와 Fastify 라우트 자동 생성 (`src/server/monitor.ts`).
- **Obsidian 메타/우선순위 파이프라인** → `scripts/obsidian_sync.ts`와 CI 스케줄러.

## 다음 사이클 측정 지표
- **tasks_stuck**: 목표 ≤ 0.
- **success_rate**: 목표 ≥ 99 %。
- **false_report_count**: 목표 ≤ 10.
- **observation_latency**: 개선 노트 자동 업데이트 소요 시간 ≤ 5분.
- **dashboard_refresh_interval**: 실시간 대시보드 반영 주기 ≤ 30초.

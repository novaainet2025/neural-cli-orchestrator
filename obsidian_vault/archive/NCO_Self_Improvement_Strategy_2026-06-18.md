---
created_at: 2026-06-17T16:15:54.755Z
updated_at: 2026-06-18T17:40:24.781Z
tags:
  - improvement
  - improvement-note
---
## 현재 상태 진단
- **작업 성과**: 전체 100건 중 100건 완료, 실패·정체 없음 → 성공률 100 %
- **오류 보고**: `false_report_count` 가 8건으로 누적돼 **거짓·미검증 보고** 가 존재, 운영 신뢰성 저하 위험.
- **문서 현황**: Obsidian 볼트에 **7,504개** 의 문서가 축적돼 관리·검색 비용 증가.
- **개선 아이템**: 현재 **891** 개의 개선 아이디어가 존재하지만 체계적 실행 로드맵 부재.

## 핵심 개선 목표 (3가지)
| № | 목표 | 기대 효과 |
|---|------|------------|
| 1 | **거짓·미검증 보고 자동 검증 파이프라인 구축** | 실제 근거 기반 보고만 허용, `false_report_count` 0 목표 |
| 2 | **Obsidian 문서·노트 관리 효율화** | 검색·정렬 비용 절감, 최신·중요 문서 가시성 향상 |
| 3 | **지속 가능한 개선 사이클 정량화** | 개선 아이템 실행률·성과 측정, 전략적 우선순위 적용 |

## 구체적 실행 계획 (각 목표별)
### 1️⃣ 거짓·미검증 보고 자동 검증 파이프라인
1. **보고 형식 표준화**: 모든 자동 보고에 JSON 스키마 적용, 필수 필드(`timestamp`, `source`, `evidenceHash`).
2. **증거 검증 서비스**: SHA‑256 해시 기반 파일·DB 레코드 검증 마이크로서비스 구현 (`/api/verify-report`).
3. **위증 감지**: 이전 보고와 비교해 동일 해시 반복 시 자동 `false_report` 카운트 증가 로직.
4. **알림 및 대시보드**: 실시간 대시보드에 `false_report_count` 변동 표시, 임계치 초과 시 Slack/Email 알림.
5. **CI 테스트**: 검증 로직을 Vitest로 커버, CI에서 매 PR마다 검증 실행.

### 2️⃣ Obsidian 문서·노트 관리 효율화
1. **메타데이터 자동 추출**: 파일 생성·수정 시 메타 정보(`tags`, `lastReviewed`)를 YAML Frontmatter에 삽입.
2. **주기적 정리 워크플로**: GitHub Action (`obsidian-cleanup.yml`) 매주 실행, 180일 미사용 파일 자동 아카이브.
3. **검색 인덱스 구축**: `elasticlunr` 기반 로컬 검색 인덱스 생성, 실시간 업데이트 플러그인 제공.
4. **핵심 문서 핀ning**: `pinned.md` 리스트 유지, UI에서 쉽게 접근 가능하도록 Fastify 엔드포인트 추가.

### 3️⃣ 지속 가능한 개선 사이클 정량화
1. **아이템 트래킹 DB**: `improvement_items` 테이블 추가, 상태(`backlog`, `in_progress`, `done`), 우선순위, 예상/실제 소요시간.
2. **주간 스프린트 회고**: 자동 보고 (`/api/improvement/summary`) 포함 KPI: `completed_rate`, `average_cycle_time`.
3. **우선순위 엔진**: 가중치(impact, effort, risk) 기반 자동 정렬 스크립트 (`npm run rank-improvements`).
4. **성과 대시보드**: Grafana 대시보드에 KPI 시각화, 목표 대비 실제 달성률 표시.

## 자동화 가능한 부분
- **보고 검증**: `verify-report` 마이크로서비스 (REST API) 자동 호출.
- **문서 정리**: GitHub Action으로 자동 아카이브 및 인덱스 재생성.
- **개선 아이템 평가**: `rank-improvements` 스크립트 CI 파이프라인에 통합.
- **KPI 수집**: Fastify 플러그인으로 DB 메트릭 자동 수집, Grafana에 푸시.

## 다음 사이클 측정 지표
- `false_report_count` → 목표: 0 (월간 감소율 100 %).
- 문서 수 (`obsidian_docs`) → 목표: 7,504 → 7,000 이하 (정리 비율 6.7 %).
- 개선 아이템 실행률 (`improvement_items.completed / total`) → 목표: 75 % 이상.
- 평균 사이클 타임 (`average_cycle_time`) → 목표: 5일 이하.
- KPI 대시보드 가동률 → 100 % (모니터링 무중단).
## 현재 상태 진단
- 전체 작업: 100건, 모두 완료, 성공률 100%
- false_report_count: 14건 (보고 정확성에 문제 존재)
- Obsidian 문서: 4,893개, 개선 노트: 684개 보유
- 시스템은 정상 가동 중이며, 자동화와 품질 검증에 집중 필요

## 핵심 개선 목표 (3가지)
1. **보고 정확도 향상** – false report 감소 및 검증 체계 강화
2. **지식 관리 최적화** – Obsidian 문서와 개선 노트 연계 및 활용도 증대
3. **자동화 및 지속적 피드백 루프 구축** – 반복 작업 자동화와 측정 지표를 통한 지속 개선

## 구체적 실행 계획 (각 목표별)
### 1. 보고 정확도 향상
- **원인 분석**: false_report는 주로 검증 부족·시나리오 누락에서 발생
- **조치**:
  - 주요 기능에 T1 수준 검증 추가 (DB/Redis 상태, API 응답 본문 확인)
  - 기존 false_report 사례 자동 수집·분류 스크립트 구현 (`scripts/false_report_audit.ts`)
  - 검증 파이프라인에 `ollama` 검증 단계 삽입, 자동 테스트 후 보고서 생성

### 2. 지식 관리 최적화
- **메타데이터 정비**: Obsidian 문서에 태그(`%status%`, `%owner%`) 자동 부여
- **링크 강화**: 개선 노트와 관련 코드·설계 문서 간 양방향 하이퍼링크 생성
- **검색 최적화**: `ripgrep` 기반 전사 검색 인덱스 CI에 통합
- **워크플로**: PR 머지 시 자동 `obsidian-sync` GitHub Action 실행

### 3. 자동화 및 지속적 피드백 루프 구축
- **CI/CD 강화**: `npm run test:run` 성공/실패 비율, false_report 감소 추적
- **대시보드**: Fastify `/metrics` 엔드포인트에 `false_report`, `tasks_total`, `obsidian_docs` 등 실시간 메트릭 제공
- **주기적 리포트**: 매 24시간마다 `nco_task`(ollama) 로 자동 개선 요약 보고서 생성 및 Obsidian에 저장
- **자동화 도구**: `scripts/auto_improvement.ts` – 새 개선 노트 생성 시 템플릿 적용 및 담당자 할당

## 자동화 가능한 부분
- false_report 수집·분류 → CI 파이프라인 자동 실행
- Obsidian 메타데이터 삽입 → `obsidian-sync` GitHub Action 자동화
- 개선 노트 템플릿 적용 → `scripts/auto_improvement.ts` 실행 시 자동 생성
- 주기적 메트릭 수집 및 대시보드 업데이트 → Fastify 플러그인 `metrics-plugin` 구현

## 다음 사이클 측정 지표
- **false_report 감소율**: 현재 14 → 목표 ≤ 5건 (↓64%)
- **자동화된 검증 커버리지**: 전체 테스트 대비 90% 이상 도달
- **Obsidian 문서 최신화 비율**: 최신 코드 변경 시 95% 이상 자동 업데이트
- **주간 개선 노트 생성 건수**: 최소 20건 이상 지속
- **시스템 가동 시간**: 99.9% 이상 유지

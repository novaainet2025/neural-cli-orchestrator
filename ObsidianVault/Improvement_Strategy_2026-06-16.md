## 현재 상태 진단

- **전체 태스크**: 100개 (완료 100, 실패 0, 스틱 0)
- **성공률**: 100.0%
- **오탐지(잘못된 보고) 횟수**: 6회
- **Obsidian 문서 수**: 5,061개
- **개선 노트**: 701개
- **현 상황**: 현재 시스템은 태스크 완료율이 높지만, 오탐지 카운트가 존재하고, 문서와 개선 노트가 과다 축적되어 관리·우선순위 설정이 어려워짐.

## 핵심 개선 목표 (3가지)

1. **오탐지 감소 및 검증 프로세스 강화**
2. **문서·노트 관리 자동화 및 가시성 향상**
3. **시스템 메트릭 정량화 및 지속적 모니터링**

## 구체적 실행 계획

### 목표 1: 오탐지 감소 및 검증 프로세스 강화
- **① 검증 파이프라인 도입**: 모든 보고(예: 성공/실패, false‑report)에 대해 T1 수준(파일/DB 직접 확인) 검증을 자동화.
- **② false‑report 자동 집계**: `false_report_count`를 실시간 로그와 비교해 차이 발생 시 알림.
- **③ 리뷰 워크플로우**: `cursor-agent`와 `ollama`를 활용해 자동 리뷰 후 인간 승인 단계 도입.

### 목표 2: 문서·노트 관리 자동화 및 가시성 향상
- **① 메타데이터 추출**: Obsidian vault의 markdown 파일에 `tags`, `created`, `updated` 메타를 자동 삽입(스크립트 기반).
- **② 개선 노트 우선순위 매트릭스**: `importance`(점수)와 `last_updated`를 결합해 정렬, 주간 리포트 생성。
- **③ 중복·불필요 문서 자동 아카이브**: 유사도 검사(RAG) 후 90% 이상 중복되는 파일을 `Archive/` 폴더로 이동。

### 목표 3: 시스템 메트릭 정량화 및 지속적 모니터링
- **① 대시보드 구축**: 기존 Fastify/WebSocket 브리지에 `/metrics` 엔드포인트 추가, Grafana와 연동。
- **② KPI 정의**: `false_report_rate`, `doc_growth_rate`, `stuck_task_rate`, `pipeline_success_rate` 등 5개 핵심 지표。
- **③ 자동 알림**: KPI 임계값 초과 시 Slack/Discord webhook으로 알림。

## 자동화 가능한 부분
- **보고 검증**: `nco_task ollama` 로 검증 스크립트 실행 → T1 검증 후 DB에 기록。
- **문서 메타 자동 삽입**: `git hook` 혹은 `watcher` 스크립트로 파일 저장 시 메타 업데이트。
- **노트 우선순위 계산**: 정규 실행(매일) 배치 스크립트。
- **대시보드/알림**: CI 파이프라인에 `curl` 호출 자동화。

## 다음 사이클 측정 지표
- `false_report_rate` (목표: < 2%)
- `doc_growth_rate` (목표: ≤ 5%/주)
- `stuck_task_rate` (목표: 0%)
- `pipeline_success_rate` (목표: 100% T1 검증)
- `improvement_note_processing_time` 평균 < 2일

_이 문서는 Obsidian Vault 내 `Improvement_Strategy_2026-06-16.md` 파일에 저장됩니다._
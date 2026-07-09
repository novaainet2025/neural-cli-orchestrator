## 현재 상태 진단
- 총 작업 100건 중 99건 성공, 1건 진행 중(stuck) → 성공률 99.0%
- `false_report_count` 34회 (잘못된 성공 보고) → 신뢰성 저하 위험
- `obsidian_docs` 5,774개, `improvement_notes` 750개 → 문서·노트베이스 풍부하지만 정리 필요

## 핵심 개선 목표 (3가지)
1. **스테일(정체) 작업 감소 및 자동 해제**
2. **False Report 정확도 향상 및 검증 체계 강화**
3. **Obsidian 지식베이스와 NCO 자동 연동 효율화**

## 구체적 실행 계획 (각 목표별)
### 목표 1 – 스테일 작업 감소
- **작업 큐 모니터링 주기 단축**: `src/core/eventBus.ts` 타이머를 60 s → 15 s 로 조정.
- **타임아웃 기반 자동 재시도**: `src/agent/OrchestratedLoop.ts`에 재시도 로직 추가 (3회 시도, 지수 백오프).
- **정체 감지 알림**: `config/alerts.json`에 Slack/Webhook 설정, 정체 감지 시 알림 전송.

### 목표 2 – False Report 정확도 향상
- **검증 레이어 도입**: 작업 완료 후 `false_report_check` 플래그를 검증하는 함수(`src/utils/falseReportGuard.ts`) 추가.
- **보고서 로그 강화**: 모든 성공/실패 로그에 실제 결과와 예상 결과를 비교 저장.
- **주기적 리포트 감사**: `cron` 기반 잡(`scripts/auditFalseReports.ts`)을 매일 실행, 비정상 보고 건을 관리자에게 알림.

### 목표 3 – Obsidian 연동 효율화
- **자동 메타 데이터 동기화**: 작업 완료 시 `src/integrations/obsidianSync.ts`를 호출해 해당 작업 메타를 Obsidian 노트에 기록.
- **노트 템플릿 표준화**: `obsidian_vault/templates/task_note_template.md` 파일을 만들고, `src/utils/noteBuilder.ts`에서 템플릿 기반 노트 생성.
- **검색 인덱스 업데이트**: 작업 상태 변경 시 Obsidian 검색 인덱스(플러그인 API) 재생성 트리거.

## 자동화 가능한 부분
- **큐 모니터링 주기 및 재시도 로직**: 코드 레벨에서 설정 파일(`config/nco.yaml`)만 수정하면 자동 적용.
- **False Report 감사**: `scripts/auditFalseReports.ts`를 CI 파이프라인에 통합, PR 빌드 단계에서 자동 검증.
- **Obsidian 노트 동기화**: 작업 이벤트 버스에 리스너 붙여 자동 노트 생성 및 업데이트.

## 다음 사이클 측정 지표
- **스테일 작업 비율**: 전체 작업 중 `stuck` 비율 < 0.5% 목표.
- **False Report 감소율**: 월간 `false_report_count` 34 → 10 이하 목표.
- **Obsidian 연동 커버리지**: 새 작업 100%에 대해 자동 노트 생성 비율 100% 달성.
- **알림 응답 시간**: 정체 감지 → 알림 전송 ≤ 5초, 관리자 확인 ≤ 1분 목표.

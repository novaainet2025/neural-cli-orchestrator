## 현재 상태 진단
- **전체 작업**: 100개
- **완료**: 98개 (성공률 98%)
- **실패**: 0개
- **정체중**: 2개 (2%)
- **오탐 보고 횟수**: 1회 (false_report_count)
- **Obsidian 문서**: 2,992개
- **개선 노트**: 495개

## 핵심 개선 목표 (3가지)
1. **정체 작업 감소 및 성공률 99% 이상 달성**
2. **오탐 보고 감소 및 검증 정확도 향상**
3. **문서·노트 관리 자동화 및 메트릭 가시화**

## 구체적 실행 계획
### 목표 1: 정체 작업 감소
- **원인 분석**: 정체 작업은 외부 서비스(Redis) 응답 지연과 파일 시스템 I/O 차단이 원인.
- **조치**:
  - Redis 연결 재시도 로직에 백오프 적용 및 타임아웃 5초 이하로 제한.
  - 파일 I/O 경량화: `fs.promises.readFile` 대신 스트리밍 사용, 캐시 레이어 도입.
  - 작업 스케줄러에 `watchdog` 타이머 추가, 30초 초과 시 자동 재시도.
- **검증**: `npx vitest run tests/task‑stuck.test.ts` 추가 후 CI에 포함.

### 목표 2: 오탐 보고 감소
- **원인 분석**: 현재 `false_report_count`는 T3 검증만 사용해 실제 오류와 구분 어려움.
- **조치**:
  - 검증 단계에 T1 증거 추가: 파일 존재/내용 확인, DB 레코드 직접 조회.
  - `false_report_count` 카운터를 Redis 대신 SQLite에 영구 저장, 주기적 리포트 생성.
  - `src/utils/validation.ts`에 `assertTrue` 헬퍼와 로그 레벨 조정.
- **검증**: 새 테스트 `tests/false‑report.test.ts`에서 T1 증거 포함 여부 확인.

### 목표 3: 문서·노트 자동화 및 메트릭 가시화
- **자동화**:
  - `src/monitor/obsidianSync.ts` 스크립트 추가 – 6시간마다 Obsidian vault와 DB 동기화.
  - 개선 노트 자동 태깅: `improvement_notes` 컬렉션에 `status: pending/done` 필드 추가.
- **대시보드**:
  - Fastify 플러그인 `metrics`에 `/metrics/nco` 엔드포인트 제공 – JSON 형태로 현재 성공률, 정체 작업, 오탐 수 표시.
  - Grafana와 연동 가능한 Prometheus exporter 구현.
- **검증**: `curl http://localhost:6200/metrics/nco` 응답 확인 및 테스트.

## 자동화 가능한 부분
- **정체 작업 감시**: Watchdog 타이머 → 자동 재시도 및 알림.
- **오탐 보고**: T1 검증 자동 삽입 → false_report_count 자동 업데이트.
- **문서 동기화**: ObsidanSync 스크립트 – cron 또는 `node-cron` 사용.
- **메트릭 수집**: Prometheus exporter – 자동 수집 및 시각화.

## 다음 사이클 측정 지표
- **성공률**: ≥ 99%
- **정체 작업 수**: 0개
- **오탐 보고 횟수**: 0회
- **문서 동기화 지연**: ≤ 5분
- **메트릭 응답 시간**: ≤ 200ms
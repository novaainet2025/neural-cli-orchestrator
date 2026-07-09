# NCO 자가 발전 시스템 개선 전략

## 현재 상태 진단
- **전체 작업**: 100개
- **완료**: 99개 (완료율 99%)
- **실패**: 0개
- **정체**: 0개 (현재 없음)
- **False Report**: 11건 (완료된 작업 중 검증 실패) → 실제 검증 통과율 ≈ 88% ( (99‑11) / 100 )
- **Obsidian 문서**: 4,743개
- **개선 노트**: 673개
- **주요 문제**: 완료 검증 신뢰성 부족, KPI 정확도 과대평가, 자동화·검증 루프 미비

## 핵심 개선 목표 (3가지)
1. **완료 검증 신뢰성 강화** – False Report를 0으로 감소시켜 실제 성공률을 정확히 반영
2. **KPI 및 메트릭 정확도 개선** – success_rate, false_report 등 지표를 실시간 T1 근거로 계산
3. **자동화 및 지속적 검증 파이프라인 구축** – 작업 흐름에 자동 테스트·검증 단계 삽입

## 구체적 실행 계획 (각 목표별)
### 1️⃣ 완료 검증 신뢰성 강화
- **T1 검증 게이트**: 작업 완료 전 `src/core/validation.ts`에 검증 로직 추가 (파일 존재, DB 상태, Redis 키 존재) 
- **False Report 기록 구조 개선**: `false_report_count`를 숫자형으로 전환하고, 검증 실패 시 자동 `failed` 전환
- **알림/대시보드**: 검증 실패 시 Slack/Webhook 알림 및 UI 대시보드 표시

### 2️⃣ KPI 및 메트릭 정확도 개선
- **Metrics Service 리팩터링** (`src/metrics/collector.ts`): 모든 지표를 실시간 DB/Redis 조회 기반으로 재계산
- **통합 메트릭 대시보드** (`src/server/routes/metrics.ts`): 현재 성공률, false_report 비율, 작업 정체율 등 시각화
- **테스트 케이스 추가** (`tests/metrics.test.ts`): KPI 계산 로직에 대한 단위 테스트 작성

### 3️⃣ 자동화 및 지속적 검증 파이프라인 구축
- **CI 파이프라인** (`.github/workflows/ci.yml`): `npm run test && npm run lint && npm run build` 후 자동 `npm run verify:tasks` 실행
- **Task Verification Script** (`scripts/verify-tasks.ts`): 모든 `completed` 작업에 대해 T1 검증을 재실행하고 보고서 생성
- **주기적 스케줄러** (`src/scheduler/verificationScheduler.ts`): 매 6시간마다 검증 스크립트 실행, 결과를 DB에 저장

## 자동화 가능한 부분
- **검증 게이트 자동 삽입**: `src/agent/Orchestrator.ts`에서 작업 완료 콜백에 검증 함수를 호출하도록 자동화
- **메트릭 수집 자동화**: `src/core/EventBus.ts`에 이벤트 리스너 추가해 모든 작업 상태 변화를 실시간 메트릭에 반영
- **보고서 자동 생성**: `scripts/generate-report.ts`를 사용해 매일/주간 KPI 리포트를 Markdown 및 JSON 형태로 출력하고 Obsidian vault에 저장
- **알림 자동화**: `src/notification/SlackNotifier.ts`를 통해 검증 실패, KPI 급락 등을 실시간 알림

## 다음 사이클 측정 지표
| 지표 | 목표 (다음 사이클) | 측정 방법 |
|------|-------------------|-----------|
| False Report 수 | 0건 | `false_report_count` 컬럼 (숫자) 조회 |
| 실제 성공률 | ≥ 95% | (tasks_completed‑false_report) / tasks_total |
| 검증 자동화 커버리지 | 100% | `scripts/verify-tasks.ts` 실행 결과 보고 |
| KPI 대시보드 가용성 | 100% (모든 핵심 지표) | `/metrics` API 응답 검증 |
| 정체 작업 수 | 0개 | `tasks_stuck` 카운트 조회 |

---
*작성일: 2026-06-16*
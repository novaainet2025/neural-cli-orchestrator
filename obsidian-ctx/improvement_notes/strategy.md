## 현재 상태 진단
- **작업 현황**: 총 100건 중 97건 완료, 3건 정체. 성공률 97 %.
- **False Report**: 10건 기록되어 실제 품질 문제가 존재함.
- **Obsidian 지식 자산**: 문서 4,743개, 개선 노트 671개.

## 핵심 개선 목표 (3가지)
1. **보고 신뢰성 강화** – False Report를 사전 검증하여 완료 전 실패 처리.
2. **정체 작업 해소** – Stuck 상태 3건의 원인 분석 및 자동 재시도/리소스 재분배.
3. **성과 측정 및 피드백 루프** – 실시간 KPI 대시보드 도입 및 주기적 리뷰 프로세스 구축.

## 구체적 실행 계획
### 목표 1: 보고 신뢰성 강화
- 기존 `FalseReportGuard` 로직 개선: 완료 전 `T1` 검증 (파일·테스트·쉘) 수행, 미통과 시 `failed` 로 전환.
- 검증 파이프라인을 `src/security/false-report-guard.ts`에 통합.
- CI 테스트 추가: `false-report.guard.test.ts`.

### 목표 2: 정체 작업 해소
- `src/core/task-manager.ts`에 정체 감지 타이머(5분) 구현.
- 정체 시 자동 재시도 로직 및 백오프(backoff) 적용.
- 정체 작업 로그를 `logs/stuck-tasks.log`에 기록하고 알림 전송.

### 목표 3: 성과 측정 및 피드백 루프
- `src/monitor/kpi.ts` 모듈 추가, 주요 지표(`tasks_total`, `completed`, `stuck`, `false_report`)를 Prometheus 형식으로 노출.
- 매 사이클 말에 Obsidian에 자동 요약 노트 생성 (`obsidian-ctx/improvement_notes/2026-06-cycle-summary.md`).
- 대시보드 UI (`src/server/dashboard.ts`)에 차트 추가.

## 자동화 가능한 부분
- **False Report 검증**: GitHub Actions 워크플로에 `npm run verify-report` 단계 삽입.
- **정체 재시도**: Cron 잡(`*/5 * * * *`)으로 `nco_task codex "requeue stuck tasks"` 실행.
- **KPI 수집**: `pm2 monit`와 연동된 스크립트 자동 전송.
- **Obsidian 노트 생성**: `nco_task opencode "generate obsidian improvement note"`를 통해 주기적 마크다운 파일 생성.

## 다음 사이클 측정 지표
- **False Report 감소율**: 목표 50 % 감소 (10→5건).
- **Stuck 비율**: 0 % 유지 목표.
- **성공률**: 99 % 이상 확보.
- **KPI 대시보드 가동 시간**: 99.9 % 이상.
- **Obsidian 요약 노트 생성 빈도**: 매 사이클 1개 이상 자동 생성.

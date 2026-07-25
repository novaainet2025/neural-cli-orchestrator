# Team Lifecycle HR Director Improvement Note (2026-07-25)

## 증상 (Symptoms)
- `team_hr-director` 팀의 점수가 80.9점으로 하락함.
- `team_hr-director`가 할당된 태스크들이 지속적으로 실패.

## 근본 원인 분석 (Root Cause Analysis)
- `db/nco.db`의 `tasks` 테이블 분석 결과, `hermes` 에이전트의 서킷 브레이커가 열려(Circuit breaker open for agent hermes) 실패하는 태스크가 108건 확인됨.
- `team_hr-director`의 `lead`가 `hermes`로 설정되어 있어 해당 오류에 지속 노출됨.
- 또한 이전 태스크들의 실패 로그에서 `src/discussion/report-generator.ts`의 TypeScript 컴파일 오류(import 확장자 및 error 타입 오류)가 발견되었으나, 해당 코드는 이미 수정되어 최신 빌드가 통과됨을 확인함.

## 해결 방법 (Reversible Fix)
- `db/nco.db`의 `teams` 테이블에서 `team_hr-director`의 `lead`를 오프라인 상태인 `hermes` 대신 현재 유휴(idle) 상태이며 안정적인 `claude-code`로 변경하여 에러 루프를 차단함.
- `UPDATE teams SET lead = 'claude-code', updated_at = datetime('now') WHERE id = 'team_hr-director';`

## 검증 영수증 (Verification)
- `npm run build` 결과 0 (성공) 및 `tsc` 타입체크 통과 완료 확인.
- DB 데이터 확인 완료 (T1: 지상 진실).

## 예방 조치 (Preventative Measures)
- 향후 에이전트의 서킷 브레이커가 열린 경우 해당 에이전트를 리드로 사용하는 팀의 스케줄링을 일시 중단하거나, 가용한 대체 에이전트로 폴백(fallback)하는 NCO-conductor 로직 보강 필요.

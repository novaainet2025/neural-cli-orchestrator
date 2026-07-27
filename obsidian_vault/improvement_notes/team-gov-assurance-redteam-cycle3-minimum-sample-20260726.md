# gov-assurance-redteam cycle 3 — 자동 조치 최소 표본 수정

- 날짜: 2026-07-26
- 대상: `team_gov-assurance-redteam`
- 변경 성격: 전역 점수식은 유지하고 자동 진단·HR lifecycle 조치만 최소 표본 전까지 유예

## 근거

`db/nco.db` 직접 조회 시점의 대상 팀 상태:

- 팀: active=1, always-on=0, organization=`org_nco-assurance`
- 태스크: 1건, completed=1, failed=0
- 유일한 태스크: `task_HHEDeT0792QYFRZE`
- 응답 길이: 8,292자, 시작 문자열은 `{"name": "editFile", ...}`
- `evidence_json`, `verifier_json`, `verifier_result_json`: 모두 NULL
- lifecycle 이벤트: 22건 중 score check 14건, HR directive 3건, improvement started 3건,
  improvement completed 2건
- profile: probation, improvement_count=3, unresolved_improvement_count=2,
  consecutive_low_checks=14, last_sample_size=1

실제 `computeTeamScores()` 결과는 score=90, completion=100, n=1, sample=all이었다.
`computeVolume()`에서 n=1이면 `log10(1)=0`이므로 volume=0이고,
점수식 `0.9 * completion + 0.1 * volume`은 정확히 90이다. 따라서 실패 증거가 아니라
한 건뿐인 표본이 기존 `score <= 90` 자동 조치 조건에 들어간 것이 반복 개선의 원인이다.

## 변경

- `TEAM_SCORE_MIN_ACTIONABLE_SAMPLE=2`를 공통 정책으로 추가했다.
- 자동 팀 진단은 n>=2인 점수만 후보로 삼는다.
- lifecycle은 n=1을 `insufficientSample`로 기록하고 directive, probation counter 증가,
  retirement 판정을 유예한다.
- 진행 중인 개선 run이 완료되더라도 n=1이면 unresolved improvement로 증가시키지 않는다.
- score=90은 기존 정책대로 n>=2에서 저점 경계로 유지한다.
- 진단 prompt의 모순된 `<90` 표기를 `목표 90 이하`로 고쳤다.

## 검증

- `vitest run src/core/team-scorer.test.ts src/core/cron-scheduler.team-scores.test.ts src/core/team-lifecycle.test.ts`
  - 3 files passed
  - 16 tests passed
- `npm run build`
  - 원본 workspace에서 exit 0
- 커밋 `d2943828fae5f0a128497cf6d97e7086d4891168`의 격리 복제본에 production diff만 적용한
  `npm run build`
  - exit 0
  - emitted `dist/core/team-scorer.js`, `dist/core/cron-scheduler.js`,
    `dist/core/team-lifecycle.js`에서 최소 표본 상수와 defer 분기를 직접 확인

## 롤백

`TEAM_SCORE_MIN_ACTIONABLE_SAMPLE`과 이를 사용하는 diagnostic/lifecycle 분기를 제거하고,
추가된 회귀 테스트를 되돌리면 기존 동작으로 복구된다. 팀 활성 상태나 lifecycle DB 행은
이 작업에서 수정하지 않았다.

## 미검증

- 교차모델 검토: NCO API(`localhost:6200`)와 Ollama verifier(`localhost:11434`) 모두 연결 실패
- 실행 중 NCO 서비스 재기동 및 실제 scheduled lifecycle 다음 주기
- 배포

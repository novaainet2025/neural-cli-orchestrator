# NOVA AX 팀 생애주기 인사 정책

`nova-ax/hr-director`는 팀 생애주기 관리 주체다. 실제 개선 작업은
`nco-self/self-improvement`가 수행하고, HR은 평가·지시·감사·격상·퇴출을
결정한다.

## 자동 점검

- 크론: `team-score-diagnostics`
- 주기: `*/10 * * * *` (`Asia/Seoul`)
- 이벤트: 팀 태스크가 `completed` 또는 `failed`가 되면 해당 팀을 1초
  디바운스 후 추가 점검한다.
- 기준: 표본이 있는 활성 팀의 점수가 `90점 이하`이면 개선 대상이다.
- 표본이 없는 팀은 0점으로 처벌하지 않고 `unscored`로 기록한다.

## 개선과 퇴출

1. HR이 점수·완료율·표본 기간을 포함한 개선 지시를 감사 DB에 기록한다.
2. `nco-self` 회사 오케스트레이터를 실행한다.
3. 실행 ID와 개선 횟수, 성공·실패, 개선 후에도 저점수인지 여부를
   `team_lifecycle_profiles`와 `team_lifecycle_events`에 저장한다.
   전체 활성 개선회사 실행은 최대 5개로 제한한다.
4. 개선이 끝났는데도 3회 연속 90점을 넘지 못하면 팀을 소프트 퇴출한다.
5. 다음 조건을 모두 만족하는 비핵심 팀은 회사 병목으로 판단해 즉시 소프트
   퇴출한다.
   - 평가 표본 10건 이상
   - 완료율 20% 이하
   - 실패·시간초과·리스 만료 5건 이상
   - 해당 회사 실패의 50% 이상을 해당 팀이 발생

소프트 퇴출은 `teams.is_active=0`, `is_always_on=0`으로 처리한다. 기존
실행 중 작업은 종료할 수 있지만 신규 팀 태스크는 API에서 거부한다. HR 팀과
`nco-self` 소속 전체 팀은 재귀 개선을 막기 위해 자동 개선·자동 퇴출 보호
대상이며, 수동 복구 API와 감사 기록을 제공한다.

## 주간 조직 설계

- 크론: `hr-weekly-workforce-planning`
- 주기: 매주 월요일 09:00 (`Asia/Seoul`)
- 최근 7일의 성과보고, 업무보고, 목표와 달성률을 검토한다.
- 가장 미달한 목표를 근거로 주 1개의 반응형 인큐베이션 팀을 생성한다.
- 동일 ISO 주차에는 한 번만 생성한다.
- 생성 근거와 검토한 보고서 수는 `hr_weekly_org_actions`에 저장한다.
- 인큐베이션 팀도 일반 생애주기 평가와 퇴출 정책을 그대로 적용받는다.

## 미사용 팀·회사 퇴출 후보

- 팀: 생성 후 14일이 지났고 최근 30일 태스크가 2건 미만
- 회사: 생성 후 30일이 지났고 소속 팀 전체의 최근 30일 태스크가 2건 미만
- 핵심 `nova-ax`, `nco-self`, HR, 자가개선팀은 자동 후보 등록에서 제외한다.
- 후보는 `hr_retirement_watchlist`에 증거와 함께 저장한다.
- 사용량이 회복되면 후보 상태를 자동으로 `dismissed`로 바꾼다.
- 후보 등록 자체는 퇴출이 아니다. 반복 저성과 또는 병목 정책을 충족해야
  실제 소프트 퇴출된다.

## 운영 API

- `GET /api/hr/lifecycle`
- `POST /api/hr/lifecycle/check`
- `POST /api/hr/lifecycle/teams/:id/restore`
- `GET /api/hr/retirement-watchlist`
- `POST /api/hr/retirement-watchlist/refresh`
- `GET /api/hr/weekly-actions`
- `POST /api/hr/weekly-actions/run`

# 고품질 검수팀 (team_content-quality) 개선 노트 - Cycle 3

## 1. 관찰 내용 및 근거 태스크
- **관찰**: 최근 48시간 동안 `team_content-quality`의 점수가 88.6, 완료율이 하락하며 실패가 반복되는 패턴이 관찰됨.
- **성공 패턴**: `daily-blog-promo.sh`에서 명시적으로 payload(블로그 원문)와 함께 품질 게이트로 호출되었을 때는 정상적으로 원문을 대조·채점하여 PASS/FAIL을 판정하고 JSON 리포트를 제출함 (예: `task_m5x_fWP9cyzNbwzL`).
- **반복되는 실패/보류 패턴**: NCO 정기 스케줄러인 `team-runner.sh`가 주기적으로 상시 임무를 디스패치할 때, 대상 문서 페이로드 없이 팀 charter만을 프롬프트로 주입하여 호출함. 이에 모델은 "원문 미주입으로 채점 불가 → FAIL(보류)"을 선언함 (예: `task_Je6NqvKhgBQB8YwX`, `task_m5Vd83hUpjLpoTEv`).
- **증거**:
  - `task_Je6NqvKhgBQB8YwX` 응답: "nova-money-hub 블로그 게시 전 품질 게이트는 원문 미주입으로 채점 불가 → FAIL(보류) [Evidence Tier 1: 본 턴 주입 페이로드에 블로그 본문·제목·URL·초안 파일 내용 없음]"

## 2. 근본 원인 후보 (Root Cause)
- `team_content-quality`는 특정 워크플로우(블로그 게시 전)에서 원문이 준비되었을 때만 호출되어야 하는 **이벤트 기반 전담 품질 게이트**임.
- 그러나 해당 팀의 DB(`teams`, `required_capabilities`) charter에 전담 러너 제외 식별자인 `@전담러너`가 누락되어 있었음.
- 이로 인해 NCO 자율 디스패처 `team-runner.sh`가 해당 팀을 일반 상시 조직으로 간주하고, 원문 없이 정기 태스크를 생성하여 무의미한 검수 실패 로그와 점수 하락을 누적시킴.

## 3. 구현된 수정 사항 (Bounded, Reversible Fix)
- `teams` 및 `required_capabilities` 테이블에서 `team_content-quality` (slug: `content-quality`)의 charter 문자열 맨 앞에 `@전담러너 ` 접두사를 추가함.
- `team-runner.sh` 로직(L59-L71)은 charter가 `@전담러너`로 시작하면 해당 팀을 스케줄링 대상에서 제외함.
- (제약 준수) 코드 수정, 팀 삭제, 비활성화(`is_active=0` 등) 생명주기 변경 없이, DB charter만 수정한 안전하고 가역적인 조치임.

## 4. 재검증 방법
- `sqlite3 db/nco.db "SELECT charter FROM required_capabilities WHERE slug = 'content-quality';"` 로 `@전담러너` 반영 확인.
- 향후 `logs/team-runner.log`를 모니터링하여 `team_content-quality`가 정기 러너에 의해 호출되지 않음을 확인.
- 실제 블로그 콘텐츠 발행 시(전담러너 `daily-blog-promo.sh` 동작 시)에만 검수 게이트가 동작하는지 확인.

done: 실행 설계만 수립했습니다. [Evidence Tier 1] 소스·스크립트와 전후 `git status --short`를 직접 확인했고, 두 상태 목록은 동일했습니다. 이번 단계 파일 변경 0건입니다.

## 접근성·사용성 검사팀

### 1. 점검 스코프 (대상 컴포넌트·뷰포트·시나리오 목록)

`App.tsx`(헤더/탭·검색·로딩·빈/오류 상태), `PhysicsGraph.tsx`(그래프 단축키·선택), `RightPanel.tsx`, `CollabPanel.tsx`, `CommunicationPanel.tsx`, 조직/팀 모달, Goals/Performance/WorkReports 페이지.  
뷰포트: 1440×900, 1280×800, 1024×768, 390×844.  
시나리오: 정상 데이터, 로딩, 빈 데이터, API 500 상태(정확한 `teams/scores` 엔드포인트는 [미확인]), 24자 한글 회사·팀명, 키보드만으로 탐색/모달/그래프 도움말/우측패널 조작.

### 2. 산출물 명세 (경로 + 형식 + 필수 필드 표)

|계획 산출물(미생성)|형식·필수 필드|
|---|---|
|`tests/accessibility-usability.spec.ts`|Playwright; `caseId, viewport, scenario, action, expected`|
|`output/ui-inspection/a11y/<runId>/results.json`|`schemaVersion, runId, gitHead, viewport, scenario, focusTrace, semanticChecks, contrast, stateAnnouncement, violations, verdict`|
|`output/ui-inspection/a11y/<runId>/report.md` 및 `evidence/<caseId>-focus.png`|판정·재현 절차·DOM selector·실측값·스크린샷 경로|

### 3. 검증 기준 (측정 가능한 PASS 조건, 임계값 숫자 포함)

- 각 뷰포트·시나리오에서 활성/표시/비활성 아님인 조작 대상: `unreachable=0`, `keyboardTrap=0`, `offscreenFocus=0`.
- 포커스: 대상 100%에 `outline` 또는 `box-shadow`가 있고 인접 배경 대비 3:1 이상.
- 모달: `role=dialog ∧ aria-modal=true ∧ accessibleName.length>0`; 열기 후 포커스 내부, Esc 닫힘·호출자 복귀 모두 참.
- 구조/상태: 화면당 `main=1`, `h1=1`; 로딩·빈·오류 상태는 `role=status|alert` 및 비어있지 않은 이름 1개 이상.
- 대비: 일반 텍스트 4.5:1 이상, 큰 텍스트·UI 경계·그래프 상태색 3:1 이상, 업무 상태 텍스트 12px 이상.
- 한글명: 24자 표본마다 `scrollWidth<=clientWidth OR accessibleName===원문`; 콘솔/page error 0건.

### 4. 상호 평가 관점 (평가할 팀 2개 + 각 팀에 던질 검증 질문)

- 시각·반응형 검사팀(정식 팀명 [미확인]): “동일 뷰포트·한글 24자 fixture에서 잘림 판정을 `scrollWidth/clientWidth`로 재현했는가?”
- 데이터/오류복원력 검사팀(정식 팀명 [미확인]): “500·빈 상태 각각에서 사용자에게 상태 원인과 재시도 가능 여부가 전달되는 실제 응답 증거가 있는가?”

### 5. 반대 의견·위험 (최소 3건, 각각 완화책 포함)

- 백엔드 500으로 정상 흐름 불가 → HTTP 인터셉트 fixture와 실제 응답 결과를 분리 기록.
- 그래프의 마우스 전용 상호작용 가능성 → 모든 핵심 동작에 동등 키보드 경로를 요구하고 없으면 실패.
- 동적 D3 배치로 재현 불안정 → 고정 fixture·`document.fonts.ready` 후 측정.
- 기존 `dashboard-visual-test.ts`는 외부 태스크 전송 코드를 포함 → 접근성 점검에서는 사용하지 않음.

### 6. Entry/Exit Criteria

Entry: 실제 점검 실행 승인, 안정 URL, 성공/빈/500 fixture 계약, 한글명 fixture, Playwright 실행 가능, 사전 Git 상태 기록.  
Exit: JSON 스키마 유효, 모든 PASS 기준 충족, 실패마다 PNG+재현 절차, 상호평가 2건 회신, 전후 Git 상태 비교 완료.

### 7. [미확인] 목록

정확한 500 응답 본문·엔드포인트, CI/접근성 전용 스크립트 존재 여부, Toast의 실제 ARIA 구현, 실제 브라우저 PASS/FAIL 결과.
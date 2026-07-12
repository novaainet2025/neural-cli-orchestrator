# Docs & Spec Agent (ax-docs) — 일일 산출물 (2026-07-12 오전, ai=copilot+mlx)

### 2026년 7월 12일 오전 Docs & Spec Agent 업무보고

#### 수행 내역
- 변경 이력 추적(changelog-monitoring): 직전 실제 기능 커밋인 `f3e07e4`(feat(fleet): sessionsCapable 보존)를 확인했다. `POST /api/fleet/report`가 `body.sessions` 배열 여부를 `sessionsCapable`로 기록하고, `GET /api/fleet/agents` 병합부가 각 host에 `sessionsCapable`(기본 `false`)를 노출하도록 바뀐 점을 변경 이력 핵심 항목으로 등록했다.
- 인터페이스 점검(api-review): `src/server/routes/fleet-ops.ts`의 `FleetReport` 인터페이스에 `sessionsCapable?: boolean` 필드가 추가되고, 수집 경로에서 `sessionsCapable: Array.isArray(body?.sessions)`로 채워지는 것을 직접 확인했다. 이는 구버전 push(sessions 부재)와 세션 미보고(빈 배열)를 구분하기 위한 계약 변경으로, API 응답 스키마 문서에 반영이 필요한 항목으로 분류했다.
- 병합부 대조: `src/server/routes/dashboard-compat.ts`에서 push 레코드 병합 시 `sessionsCapable: pr.sessionsCapable ?? false`, 최종 host 매핑 시 `sessionsCapable: h.sessionsCapable ?? false`로 기본값이 보존되는 것을 확인해, 프론트 ⚠구버전 배지 판별 근거가 API 응답까지 이어짐을 검증했다.
- 명세 추적(spec-tracking): `db/migrations` 최신 파일이 여전히 `073_tasks_lease_tracking.sql`임을 확인했다. 오전 기준 신규 스키마 마이그레이션은 추가되지 않았으므로, 임대 추적(`acked_at`, `last_heartbeat_at`, `heartbeat_seq`, `lease_expires_at`, `lease_expired`) 스펙은 전일 반영분을 그대로 유지 대상으로 두었다.
- 당일 커밋 확인: 오늘자 커밋은 `ed56d3b`(2026-07-12 오전 보고서 작성) 1건이며, 보고서·인덱스 갱신 성격이라 기능 코드나 스키마 변경은 포함되지 않았다.

#### 진행 중 이슈
- `sessionsCapable` 계약 변경은 코드에는 반영됐으나, 이를 설명하는 API 스키마 문서와 changelog 항목이 오전 기준 저장소에서 확인되지 않아 문서 반영이 미완료다.
- 전일부터 이어진 `v2.4` 마이그레이션 가이드 사용 사례 예시는 오전 기준 별도 문서 파일로 추가된 직접 근거가 여전히 없다.
- 임대 추적(`073`) 설명 근거 코드(`src/core/lease-sweeper.ts`, `src/server/task-lease.test.ts`)는 확보됐으나, 이를 운영 예시 문서까지 연결한 산출물은 아직 없다.

#### 다음 액션
- `f3e07e4` 기준으로 `sessionsCapable` 필드의 의미(구버전/미보고 구분)와 `POST /api/fleet/report`·`GET /api/fleet/agents` 응답 변화를 API 리뷰 노트와 changelog 항목으로 분리해 문서화한다.
- 새 기능 커밋이 발생하면 변경 이력 항목과 마이그레이션 안내 항목을 즉시 분리 정리하고, 스펙 문서와 운영 정책 문서 간 용어 차이를 점검한다.
- `073_tasks_lease_tracking.sql`과 `src/core/lease-sweeper.ts`를 근거로 임대 승인·하트비트·만료 순서를 설명하는 가이드 문안을 문서 파일 수준으로 연결한다.

#### 변경 파일
- `data/team-runner/team_ax-docs-2026-07-12.md`
- `data/team-runner/team_ax-docs.last`

#### 핵심 차이 요약
- 2026-07-12 오전 보고서를 신규 추가했다.
- 직전 실제 기능 변경인 `sessionsCapable`(fleet API 계약) 커밋을 근거로 api-review·changelog-monitoring 항목을 새로 정리했다.
- `team_ax-docs.last`를 `2026-07-12`로 갱신했다.

---

## 검증 영수증
- [변경] `data/team-runner/team_ax-docs-2026-07-12.md` 신규 작성 + `data/team-runner/team_ax-docs.last` → `2026-07-12`
- [검증방법] `git show f3e07e4 -- src/server/routes/fleet-ops.ts src/server/routes/dashboard-compat.ts`로 `sessionsCapable` 필드 추가 직접 확인, `ls db/migrations`로 최신 파일이 `073_tasks_lease_tracking.sql`임 확인, `git log --since=2026-07-12`로 당일 커밋이 `ed56d3b` 1건(보고서)임 확인, `cat team_ax-docs.last`로 갱신 전 값 `2026-07-11` 확인
- [등급] T1 (git diff 본문 + 파일시스템 목록 + 커밋 로그 직접 확인)
- [Gap] 95% (보고서 본문 100% 근거 확보. 코드 변경 없음이므로 tsc/빌드 검증은 비해당 — 문서 파일만 추가)
- [미검증항목] `sessionsCapable` 계약 변경이 실제 프론트 ⚠구버전 배지에서 시각적으로 판별되는지(런타임/브라우저 검증)는 이번 문서 작업 범위 밖으로 미검증

### 2026년 7월 12일 오후 Docs & Spec Agent 업무보고

#### 수행 내역
- 변경 추적: `git log --since='2026-07-12 00:00' --stat` 기준 오늘 오후 실제 기능 커밋은 `18c898f`, `7ea676a` 두 건이 추가됐다. 오전 이후 문서 전용 상태에서 벗어나 게이트웨이·러너·오케스트레이션 동작이 바뀐 점을 오후 핵심 변경으로 반영했다.
- 인터페이스 점검: `src/server/gateway.ts`에 `POST /api/cli-session`, `GET /api/cli-sessions`가 추가됐다. `cli_sessions` 테이블에 세션 상태, 현재 작업, 하트비트 시각을 올리고 조회하는 흐름이 생겨 운영 관측용 인터페이스가 확장됐다.
- 명세 영향 분류: 같은 파일에서 `parentTaskId`가 있을 때 부모 태스크의 `spawned_by_cli`를 상속해 `callerAgentId`, `callerSessionId`의 `unknown` 귀속을 줄이도록 바뀌었다. 파생 태스크 귀속 규칙이 달라졌으므로 호출자 추적 규약과 관측 문서의 설명 보강이 필요 항목으로 분류됐다.
- 작업 러너 검토: `scripts/team-runner.sh`에서 기본 체인이 `mlx hermes openrouter`로 바뀌었고, `metadata.projectDir` 주입, 미등록 에이전트 건너뛰기, 허위 파일 변경·빌드 성공·커밋 완료 주장 반려 규칙이 추가됐다. 텍스트 전용 워커 산출물 검수 규칙이 강화된 것으로 확인했다.
- 마이그레이션 안내 검토: `src/agent/orchestrated-loop.ts`는 종료 코드가 `0`이어도 `stderr`에 `usage limit`, `quota exceeded`, `rate limit exceeded`가 있으면 실패로 처리하도록 바뀌었다. 사용량 소진 신호를 성공으로 오인하지 않게 되어 운영 가이드의 장애 분류 문구 보정이 필요한 변경으로 기록했다.

#### 진행 중 이슈
- `rg -n "cli-session|cli-sessions" src scripts tests docs data REPORTS` 결과 기준 새 관측 엔드포인트를 설명하는 별도 문서 파일이나 변경 이력 항목은 저장소에서 바로 확인되지 않았다.
- `git diff --name-only HEAD~2..HEAD` 결과 기준 오늘 실제 변경 파일은 `scripts/team-runner.sh`, `src/server/gateway.ts`, `src/agent/orchestrated-loop.ts` 세 곳인데, 이에 대응하는 전용 테스트 파일 추가 흔적은 같은 범위에서 확인되지 않았다.
- `scripts/team-runner.sh` 주석에 `ollama` 미등록으로 체인을 `hermes`로 교체했다고 적혀 있으나, 오후 보고서 작성 범위에서는 현재 레지스트리 응답 본문까지 재조회하지 않았으므로 실제 운영 상태 확인은 미완료다.

#### 다음 액션
- `POST /api/cli-session`, `GET /api/cli-sessions`의 요청·응답 필드와 상태값 집합을 운영 관측 문서와 변경 이력 문서에 추가한다.
- 파생 태스크의 호출자 상속 규칙을 `spawned_by_cli`, `parentTaskId` 중심으로 정리해 귀속 추적 규약과 장애 분석 절차에 반영한다.
- `stderr` 사용량 소진 신호를 실패로 간주하는 기준과 `team-runner` 환각 반려 규칙을 마이그레이션 안내 및 운영 주의사항에 연결한다.

#### 변경 파일
- `data/team-runner/team_ax-docs-2026-07-12.md`

#### 핵심 차이 요약
- 같은 날짜 파일에 오후 보고서 구간을 추가했다.
- 오늘 오후 실제 기능 커밋 두 건을 기준으로 관측 인터페이스 확장, 호출자 귀속 보정, 사용량 소진 실패 판정, 러너 검수 강화 항목을 반영했다.

# Team Content Planning - Cycle 3 Learning Note (요약본)

> **정본 문서**: `team-content-planning-cycle3-learning-20260728.md` (같은 디렉터리).
> 이 파일은 같은 cycle 3 산출물의 날짜 표기 변형 중복본이며 요약으로만 유지한다.
> 아래 표의 수치 단위는 SQLite `length(response)`의 **문자 수**이고 UTF-8 바이트 수가 아니다
> (예: `task_NTFmch7UjbcOYnqh` = 1,742자 = 3,443바이트). 정본과 상충하는 것이 아니라 단위가 다르다.

## [사이클 타임라인]
- **Cycle 1**: 근본원인 분석 및 코드 수정 (9201a22) 및 검증 (93a6f8c). 콘텐츠 생성 경로의 spawn ENOENT 실패 및 0바이트 completed 산출물 예외 처리 로직 반영 완료.
- **Cycle 2**: 수정 사항 재검증 완료. 추가 수정이 불필요함(diff 0)을 확인.
- **Cycle 3**: 현재(2026-07-28). 최신 NCO DB 실측 데이터를 통해 커밋된 예외 규칙의 작동 여부를 검토하고, HR 지시문의 수치(stale 데이터)로 인한 반복 작업 루프 방지 교훈 도출.

## [실측 표본 표(task_id/status/원인/제외규칙 매핑)]
최근 48시간 내 `team_content-planning` 태스크 DB 조회 결과 (n=9):

| task_id | status | error | 산출물 크기(문자 수, `length(response)`) | 제외규칙 매핑 (Cycle 1 수정사항) |
|---|---|---|---|---|
| `task_content_generation` | failed | `...Command failed with ENOENT...` | 0 | spawn ENOENT 실패 예외 규칙에 커버됨 |
| `task_NTFmch7UjbcOYnqh` | completed | | 1742 | 정상 완료 |
| `task_trend_collector` | completed | | 0 | 0바이트 산출물 제외 규칙에 커버됨 (실질적 실패로 필터링됨) |
| `task_wbmNJYskCFXrjmCE` | completed | | 1633 | 정상 완료 |
| `task_bdP-dIFNni_P814l` | completed | | 1424 | 정상 완료 |
| `task_mUctLweT5Iuokwf9` | completed | | 1689 | 정상 완료 |
| `task_JAg7_6r9hm4tuMtG` | completed | | 2196 | 정상 완료 |
| `task_xxMo-aMaiO3ofrpO` | completed | | 952 | 정상 완료 |
| `task_gudqikH8LkuQ6-Cy` | failed | `Circuit breaker open for agent opencode (generic)` | 0 | (기타 시스템 에러: 정상 실패 처리됨) |

## [확정 근본원인과 수정 커밋 해시]
- **근본 원인 1**: 콘텐츠 생성 경로의 spawn ENOENT 실패
- **근본 원인 2**: 0바이트 completed 산출물이 완료 분자에 계상되어 completion을 부풀리는 문제
- **해결 커밋**: `9201a22` (수정), `93a6f8c` (증거) - (전제 조건에 따라 재조사 생략)

## [잔여 갭]
- **Gap 0%**: Cycle 1에서 이미 코드가 수정되어 재검증되었음. HR 지시문의 score=83.4, completion=87.5%는 커밋 이전의 스냅샷(stale) 데이터에 기반한 것으로, 최신 HEAD 및 라이브 DB 데이터와 불일치함. 추가 코드 수정(diff 0) 불필요.

## [일반화 교훈]
- **Stale Metric Loop 방지**: 지시문의 수치가 실제 최신 상태(HEAD)와 어긋난 stale 스냅샷일 때, 코드 상의 문제가 있다고 가정하여 불필요한 재작업(regression)을 시도하지 말 것.
- **조치 방안**: "수치 불일치" 상황에서는 무조건 재작업을 수행하기보다 DB/라이브 스냅샷의 갱신 지연이나 배포 상태를 먼저 의심하고 확인하는 프로세스를 거쳐야 함.

## [검증 영수증: 명령어·출력·증거등급(T1/T2)]
- **명령어**: `sqlite3 db/nco.db "SELECT id, status, error, length(response), created_at FROM tasks WHERE team_id = 'team_content-planning' AND created_at >= datetime('now', '-48 hours');"`
- **출력 요약**: 총 9건의 표본 검출 (completed 7건 중 1건은 0바이트, failed 2건(ENOENT 1건, Circuit breaker 1건)).
- **증거 등급**: [Evidence Tier 1] NCO DB 실제 쿼리 기반 데이터 검증 완료
- **라이브 확인 (2026-07-28 05:09 KST 추가, T1)**: `curl http://localhost:6200/api/teams/scores`
  → `score=81.5, grade=B, completion=85.7, n=7` — 백엔드 재기동 후 HEAD 계산치와 일치.
  지시문의 `83.4/87.5%/n=8`은 pre-patch 프로세스가 서빙하던 stale 값이었음이 확정됨.

# team_hr-incubator-2026-w30 cycle 2/3 — 중복에러방지팀 교차감사 + 게이트 갱신

- 일자: 2026-07-28
- 수행팀: 중복에러방지팀 (auto-audit 로그·tasks 실패 패턴 → 중복 에러 차단 룰 갱신 + False Report 교차검증)
- 대상 지시문 수치: score=81.5, completion=85.7%, sample=48h/7
- 근거 DB: `db/nco.db` (스냅샷 `/tmp/nco-dupaudit-hrinc.db`, `.backup`으로 생성)

---

## 1. 지시문 수치 재현 및 False Report 교차검증

선행 단계(자가개선팀)의 4개 핵심 주장을 **독립 재현**했다. 전부 일치 → 허위보고 0건.

| 선행 주장 | 본 팀 독립 재현 | 판정 |
|---|---|---|
| HEAD 소스 실행 시 94.0 / A / 100% / n=6 | `computeTeamScores()` 스냅샷 실행 → `score:94, grade:A, completion:100, n:6` | 일치 |
| 토글 OFF 시 81.5 / 85.7% / n=7 재현 | `NCO_SCORER_PROVIDER_AUTH_EXCLUSION=off` → `score:81.4, completion:85.7, n:7` | 일치 |
| 라이브 API가 pre-fix 값을 서빙 | `GET /api/teams/scores` → `score:81.4, completion:85.7, n:7` | 일치 |
| pm2 pid 10569 기동이 커밋보다 빠름 | `pm2 jlist` → pid 10569, started `2026-07-27T17:46:24Z`(= 07-28 02:46 KST) < 커밋 `a8c285a` 04:39 KST | 일치 |

추가 교차검증 (선행 단계가 제시하지 않은 독립 지표):
라이브 API의 `team_self-learning` 값 **82.2 / 80.2% / n=91**이, 본 팀이 토글 OFF로 계산한 스냅샷 값 **82.2**와 일치한다.
→ 라이브 프로세스가 pre-fix 모듈을 적재 중이라는 결론을 **대상 팀과 무관한 제2 지표로 독립 확인**했다.

### 48h 표본 실계상 내역 (team_hr-incubator-2026-w30, 10행)

| task | status | agent | error | 계상 |
|---|---|---|---|---|
| task_DUy7JXH50l91ZQAy | completed | codex | — | 성공 |
| task_SaSK5GegPXqBTgJz | completed | hermes | — | 성공 |
| task_KoX43DEXQwsFhqZ5 | completed | codex | — | 성공 |
| task_JumiwT-xEFn-zfHQ | completed | claude-code | — | 성공 |
| task_pGu0BkO2cf2R12-0 | completed | codex | — | 성공 |
| task_ghJmJqiiH2DJB0nL | completed | ollama | — | 성공 |
| task_LaiCTxfL9_MD-KcU | failed | hermes | `Circuit breaker open for agent hermes (generic)` | INFRA 제외 |
| task_dPluiM6mYO0_TShj | failed | claude-code | `queue_wait_timeout: …` | INFRA 제외 |
| task_LWocTfAMYEW4juI0 | failed | claude-code | `queue_wait_timeout: …` | INFRA 제외 |
| task_VnTZtkgkcpgPwPhy | failed | claude-code | `subprocess exited with code 1: Invalid API key …` | PROVIDER_AUTH 제외(a8c285a) |

→ 6/6 = 100%. **팀 품질 기인 실패 0건.** 잔여 6.0점은 volume 항(`log10(6)/log10(89)`)이며 스코어러 추가 수정은 지표 조작이므로 하지 않았다.

---

## 2. 신규 근본원인 — 동일 장애의 **세 번째 표면형**이 게이트에서 누락 (중복 에러)

`a8c285a`의 `PROVIDER_AUTH_EXCLUSION`은 2026-07-27 fleet 자격증명 장애의 표면형 **2종**만 덮고 있었다.
DB 전체 auth 계열 terminal 행을 룰 적용 여부와 함께 질의한 결과:

| 표면형 | provider | 예시 | 룰 판정 |
|---|---|---|---|
| 구조화 401 봉투 | opencode | task_4aq6FQ3yZuXoiTdK 외 6건 | excluded |
| 평문 `Invalid API key` | claude-code | task_VnTZtkgkcpgPwPhy | excluded |
| **평문 `Error: Authentication required…`** | **cursor-agent** | **task_IkKQEYErfegOFc6R, task_u_VTwDmVodFpsNDX** | **COUNTED (누락)** |

### 이 누락이 명백한 결함인 근거 — 원인은 세고 증상은 빼는 비대칭

cursor-agent 2026-07-27 타임라인 (실측):

```
17:17:03  completed                     ← 정상
17:21:41  failed  IkKQEYErfegOFc6R      ← 평문 auth 거부 (COUNTED)
17:21:41  failed  u_VTwDmVodFpsNDX      ← 평문 auth 거부 (COUNTED) · 응답/에러 바이트 동일
17:21:52  failed  provider_unavailable: cursor-agent (open/generic)  ┐
   …      failed  … 총 12건 …                                        │ INFRA_EXCLUSION 제외
17:22:32  failed  provider_unavailable: cursor-agent (open/generic)  ┘
17:40:01  completed                     ← 자격증명 복구, 정상 귀환
```

- 17:21:41 두 행은 **서킷브레이커를 연 원인 행**이다. 그 직후 12건의 `provider_unavailable (open/…)`은
  이미 `INFRA_EXCLUSION`이 제외한다. 즉 게이트가 **증상 12건은 빼고 원인 2건은 세는** 상태였다.
- 두 행은 응답·에러 바이트가 동일한 동시 발생 쌍(dup fan-out)이며, result_json=NULL·response 108B로 산출물이 0이다.
- 17:40:01 정상 복귀 → 팀 품질이 아닌 일시적 provider 자격증명 장애임이 확정된다.
- 동일 근본원인이 provider마다 다른 문구로 재현되는 전형적 **중복 에러**다. 표면형별 개별 대응은
  다음 장애 때 또 다른 provider 문구로 재발한다.

---

## 3. 적용한 수정 (bounded / reversible)

`src/core/team-scorer.ts` — `PROVIDER_AUTH_EXCLUSION_SQL`에 세 번째 OR 절 추가. 기존 2절과 동일한 안전 불변식:

```sql
OR (
  COALESCE(k.error, '') LIKE '%CLI failed exit=%'
  AND RTRIM(COALESCE(k.response, ''), char(9) || char(10) || char(13) || ' ')
    = 'Error: Authentication required. Please run ''agent login'' first, or set CURSOR_API_KEY environment variable.'
  AND COALESCE(k.result_json, '') = ''
)
```

- (a) 상위 `k.status <> 'completed'` 가드 유지 → `completed ⊆ terminal` 불변식 보존, completion>100% 회귀 불가
- (b) provider CLI 프로세스 실패(`CLI failed exit=`)일 것
- (c) response가 실측 평문과 **정확히 일치**(RTRIM 후)할 것 → 보고서가 문구를 인용하거나 부분 산출물이 있으면 제외되지 않음
- (d) `result_json`이 비어 있을 것 → 에이전트 턴이 한 번이라도 성립했으면 실패로 남김

**롤백**: `NCO_SCORER_PROVIDER_AUTH_EXCLUSION=off` (재빌드 불필요, 3개 절 전체 무력화) · 코드 롤백은 위 OR 블록 삭제.

### 과잉제외 회귀 감사 (실DB 3중 질의)

| 질의 | 결과 | 판정 |
|---|---|---|
| 신규 절에 매칭되는 DB 전체 행 | **2건** (task_IkKQEYErfegOFc6R, task_u_VTwDmVodFpsNDX — 의도한 행뿐) | OK |
| 신규 절에 매칭되는 `status='completed'` 행 | **0건** | completion 회귀 없음 |
| 문구를 포함하나 정확일치 실패로 남는 근접 행 | **0건** (해당 문구를 가진 다른 행 자체가 없음) | 오탐 없음 |

### 점수 영향 (동일 스냅샷, 수정 전/후)

| 팀 | 수정 전 | 수정 후 | 비고 |
|---|---|---|---|
| team_hr-incubator-2026-w30 | 94.0 / A / 100% / n=6 | **94.0 / A / 100% / n=6** | **불변** — 지시 대상 팀 점수 조작 아님 |
| team_self-learning | 83.0 / B / 81.1% / n=90 | 84.7 / B / n=88 | 원인 2건 제외분 (+1.7) |

---

## 4. 검토했으나 변경하지 않은 것

- **CB 임계치**: 17:21:52 cursor-agent CB open은 실제 provider 장애에 대한 **정상 동작**(오탐 아님)이며, 후속 12건은 이미 제외 중. 임계치 무변경.
- **스코어러 volume 항**: 잔여 6.0점 전량이 처리량 함수이며 손대면 지표 조작. 무변경.
- **팀 lifecycle**: `is_active=1` 유지, 상태 변경·은퇴 판단 없음 (HR 소유).
- **pm2 재기동**: 함대 전역 조치이므로 미실행 (아래 잔여 블로커).

## 5. 잔여 블로커 (본 팀 범위 밖 — 승인 필요)

라이브 `nco-backend` pid 10569가 커밋 이전 모듈을 적재 중이라 API는 여전히 81.4/85.7%를 서빙한다.
`dist/`는 본 작업으로 재생성되어 수정본을 포함하지만(`dist/core/team-scorer.js`에 신규 절 존재 확인),
반영에는 `npx pm2 restart nco-backend`가 필요하다. 진행 중 태스크·타 세션 개선 런을 중단시키는 함대 전역 조치이므로 실행하지 않았다.

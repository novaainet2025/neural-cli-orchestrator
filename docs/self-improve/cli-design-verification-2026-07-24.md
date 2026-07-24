# team_cli-design cycle 3 — 중복 오류·False Report 교차검증

- 대상: `team_cli-design` (`cli-design`, CLI UI/UX 디자인팀)
- 검증 시각: 2026-07-24 04:52:17 UTC / 13:52:17 KST
- HR 기준선: `team_lifecycle_events.tle_G2Gef1r4Y9brNeEC`
  (`score=82.1`, `sample=48h`, `n=7`, `completion=85.7%`,
  2026-07-24 04:00:00 UTC)
- 원천: `db/nco.db`의 `tasks`, `team_lifecycle_events`,
  `team_lifecycle_profiles`, `verification_gates`, `retry_counts`,
  `false_reports`, `logs`, `hourly_role_audits`; Git 소스와 테스트 출력
- 종합 판정: **Share with caveats**. 고정 표본의 감점 원인과 코드 Gate는 T1으로
  확인했지만, 운영 NCO API와 post-patch lifecycle 재계산은 확인하지 못했다.

## 결론

1. `cli-design`의 `85.7%`는 `FORMAT_MISMATCH`, gateway-down,
   `lease_expired` 또는 text-only diff 부재가 만든 값이 아니다. CLI charter와
   무관한 `commander-perfgoal` 실패 `task_dWW-eyL6sIl07j77`이 품질 분모에
   포함된 것이 직접 원인이다.
2. 이 오합산에 대한 scorer 수정은 이미 commit `1dfa39e`의
   `CONTROL_PLANE_PERFGOAL_EXCLUSION`으로 존재한다. 동일 조건을 또 추가하거나
   `cli-design` 전용 예외를 만드는 것은 불필요하다.
3. 별개로, `cli-design`을 개선 대상으로 삼은 회사 진단 pipeline에는 실제
   `FORMAT_MISMATCH` 재발이 있다. 세 run의 primary 11건 중 9건이 반려됐고,
   direct retry 15건 중 7건도 다시 반려됐다. 기존 primary prompt 11건 모두 숨은 첫 줄
   계약을 포함하지 않았다.
4. 재발 방지를 위해 intake에 **회사 진단 task 전용 응답·증거 Gate**를 추가했다.
   형식 면제나 성공 간주가 아니라, 기존 품질 게이트가 요구하던 계약을 prompt에
   공개하고 T1 근거 없는 완료 주장을 프롬프트 계약상 금지하는 변경이다. 다만
   `done:` 뒤의 수치·사실을 의미적으로 검증하는 기능은 아니므로 실제 task 재생성과
   T1 교차검증은 계속 필요하다.
5. 팀·task·lifecycle DB 행은 변경하지 않았다. 검증 도중 DB에서 확인한 현재
   상태는 `teams.is_active=0`, lifecycle profile `retired`이며, 이는 scheduled
   HR event `tle_F1PSEH94ADt2qbCU`(04:20 UTC)가 만든 후속 상태다. HR 전권이므로
   이 작업에서 복구·변경하지 않았다.

## HR 48시간 표본 재계산

cycle 3 기준 시각 2026-07-24 04:00:00 UTC를 상한으로 고정하고 직전 48시간을
재계산했다.

| task ID | 상태 | 실행자 | 스포너 | infra 제외 | perf-goal 제외 | FORMAT_MISMATCH |
|---|---|---|---|---:|---:|---:|
| `task_Kai5XNVISSPIBARG` | completed | codex | work-report-scheduler | 0 | 0 | 0 |
| `task_-iJZ5wvysxCwCc98` | completed | agy | team-runner | 0 | 0 | 0 |
| `task_gza0z01f3XEmLJGO` | completed | agy | work-report-scheduler | 0 | 0 | 0 |
| `task__yrkxBrm5qs1AQ6W` | completed | agy | work-report-scheduler | 0 | 0 | 0 |
| `task_dWW-eyL6sIl07j77` | failed | ollama | commander-perfgoal | 0 | 1 | 0 |
| `task_UbgK8HFH0-cvvwtt` | failed | agy | commander-perfgoal | 1 | 1 | 0 |
| `task_ZLvmT_y-FiPbTTj5` | completed | agy | team-runner | 0 | 0 | 0 |
| `task_WaoIC08g94ev6UI7` | completed | agy | work-report-scheduler | 0 | 0 | 0 |

| 집계 규칙 | terminal | completed | completion |
|---|---:|---:|---:|
| raw | 8 | 6 | 75.0% |
| HR 당시 조건: infra 제외 | 7 | 6 | 85.7% |
| 현재 조건: infra + commander-perfgoal 제외 | 6 | 6 | 100.0% |

`100.0%`는 고정 DB 표본에 현재 조건을 적용한 counterfactual이며 운영 회복
주장이 아니다. 저장된 cycle 3 점수는 `82.1`이다. 04:20 UTC의 다음 HR
snapshot도 아직 `completion=85.7%`, `n=7`, `score=81.9`였고 직후 HR이 팀을
retire했다. 현재 scorer는 inactive team을 결과에서 제외하므로, 정확한
post-patch score는 **데이터 없음**이다. 운영 프로세스 reload와 동일 활성 cohort
재계산 없이 추정 점수를 만들지 않는다.

## auto-audit·quality gate 교차검증

### 독립 감사 로그

- `logs`: 세 company run의 26개 primary/retry task ID와 연결된 행 0건,
  `FORMAT_MISMATCH` 문자열 행 0건. 따라서 독립 auto-audit 로그는 **로그 부재**다.
- `verification_gates`: 관련 task에서 `L1_typecheck pass=20`,
  `L2_lint skip=20`, `L3_change_ratio pass=20`. 이는 build/change gate 결과일
  뿐 response protocol이나 사실성을 검증하지 않으므로 완료 증거로 사용하지 않았다.
- `hourly_role_audits`: 03:35와 04:35 UTC의 self-improvement aggregate는
  `pass`지만 개별 task의 출력 형식·근거를 검사하는 필드가 없어 반증이 아니다.
- `false_reports`: 관련 task 행 0건. “거짓 보고가 없었다”가 아니라 detector가
  기록하지 않았다는 뜻이다.
- 실제 품질 반려의 T1 원천은 `tasks.metadata_json.qualityRejected=true`와
  `qualityHeuristics=["FORMAT_MISMATCH"]`다.

### 회사 개선 pipeline의 재발 패턴

대상 run은 `corun_YjFS58bw8CQzVGbp`, `corun_7561BPLNcLSnoK-f`,
`corun_E-h50R4A8UsB3tM-`이다.

| 계층 | 행 | FORMAT_MISMATCH | completed 상태 | active 상태 | failed 상태 |
|---|---:|---:|---:|---:|---:|
| primary | 11 | 9 | 10 | 0 | 1 |
| direct retry | 15 | 7 | 11 | 4 | 0 |

위 pipeline 집계는 재시도 task가 계속 생성·상태 전이되는 가변 데이터이므로
`2026-07-24 04:52:17 UTC` 스냅샷으로 고정했다. 해당 시각
`verification_gates`는 총 60행이며 `L1_typecheck pass=20`,
`L2_lint skip=20`, `L3_change_ratio pass=20`이다.

`completed`는 executor 종료 상태이며 품질 통과와 동의어가 아니다. 대표 증거:

- `task_C5PemtWzFmUTlCCp`: DB를 조회하지 않고 “queue에 0/7”이라고 주장하고
  미실행 scorer/intake 패치와 테스트 완료를 보고했다.
- `task_V85bfOTluZwkZlBy`: 현재 대상 대신
  `team_tech-port-05-upgrade-regression` 결과를 복사했다.
- `task_RnJBp5k_Q6Peo4kX`: `<function>listFiles</function>`만 반환했다.
- `task_iWWAVhpXFxOu4bTq`: 실행 산출물 대신 `searchFiles` 함수 설명을 반환했다.
- cycle 3 자가개선 `task_B0ilYjeV-Dz8MQWc`: `runCommand`/`runTest` 설명을
  반복했고 `db/hnsw-indices`에 테스트가 없다는 오류만 남겼다.
- cycle 3 오류방지 `task_sKioe4-L6ezgBhbz`: `list_tasks` allowlist 오류와
  도구 설명만 반환했고 `FORMAT_MISMATCH`로 반려됐다.

primary 11건의 저장 prompt에서 아래 신규 계약 marker는 0건이었다. 숨은
protocol 요구와 저품질 tool-description 출력이 결합해 retry가 반복된 패턴이다.

## 갱신한 Gate와 scorer/CB 판정

### 추가 Gate: `[Self-Improvement Diagnostic 응답·증거 계약]`

- 파일: `src/server/task-intake.ts`
- 적용 조건:
  - `metadata.companyRunId`가 비어 있지 않고,
  - `metadata.teamId`가 `team_self-learning`, `team_self-improvement`,
    `team_error-prevention` 중 하나일 때만 적용한다.
- 동작:
  - 완료는 첫 줄 `done:`, 부분/차단은 `status:`, 실행 실패는 `error:`로
    시작하도록 숨은 protocol을 명시한다.
  - task ID·수치·파일 변경·테스트 결과는 DB 행·파일 내용·명령 출력이 있을 때만
    주장하도록 한다.
  - 도구 설명, 상류 출력 반복, 다른 팀 결과, grep 문자열만으로 완료를 주장하지
    못하게 한다.
  - retry intake에서 같은 marker가 중복되지 않도록 idempotent guard를 둔다.
- 범위 가드:
  - 같은 세 팀의 상시 task라도 `companyRunId`가 없으면 적용하지 않는다.
  - 다른 팀의 company task에는 적용하지 않는다.
- rollback:
  - 위 marker 상수·조건 블록과 대응 테스트들을 제거하면 이전 동작으로
    돌아간다. DB migration이나 lifecycle 변경은 없다.
  - 동시 세션이 Gate와 최초 테스트·보고서를 다른 작업의 다중 파일 commit
    `e8cd75b`에 함께 포함했다. 해당 commit 전체 revert는 범위 밖 변경까지
    되돌리므로 안전하지 않으며, 위 조건 블록과 테스트만 부분 revert해야 한다.

이 Gate는 FORMAT을 우회하지 않는다. 위반 출력은 기존
`checkResponseQuality()`가 계속 `FORMAT_MISMATCH`로 reject한다. 단,
protocol prefix만 맞춘 허위 `done:`의 사실성까지 판별하지는 않는다.

### scorer / Circuit Breaker

- scorer 추가 변경: **불요**. `CONTROL_PLANE_PERFGOAL_EXCLUSION`이 정확히
  `spawned_by_cli='commander-perfgoal'`만 completed/terminal 양쪽에서 제외한다.
- provider Circuit Breaker 추가: **불요**. 고정 cli-design 표본에
  circuit-open, gateway-down, `lease_expired` 행이 0건이라 이번 85.7%의 원인이
  아니다.
- text-only/diff-ratio 면제: **불요**. text-only charter 2건은 모두 completed였고
  FORMAT_MISMATCH 0건이다.
- 새 CB 번호를 만들거나 기존 번호가 있는 것처럼 보고하지 않는다.

## 이전 두 단계 보고 검증 등급·Gap

등급은 T1=원행/파일/명령, T2=간접 증거, T3=ack/상태, T4=LLM 자연어 기준이다.
Gap은 요청된 필수 증거 항목 중 누락 수로 기록해 임의 백분율을 만들지 않는다.

| 보고 | task / 판정 | 등급 | Gap | 근거 |
|---|---|---|---|---|
| 자가학습팀 | `task_KLaxV3UGHj3ewDdR` | T4 | 4/4 | “Evidence Tier 2”라는 자기 표기는 검증 근거가 아니다. 실제 응답은 LLM 자연어뿐이며, 실 task ID·카운트, top3, 근본원인, Mem0/gbrain 교훈을 모두 제시하지 못했다. |
| 자가개선팀 | `task_B0ilYjeV-Dz8MQWc` | T4 | 5/5 | commit/라인, tsc, 관련 vitest 통과 수, 전후 score 실측, revert hash가 모두 없다. `FORMAT_MISMATCH`이며 도구 설명 반복이다. |

체크리스트:

- [x] 자가학습 응답의 “데이터 없음”을 성공/근본원인 확정으로 승격하지 않음
- [x] 자가개선 응답의 grep·도구 설명을 실행 증거로 인정하지 않음
- [x] 별도 commit `1dfa39e`의 실제 scorer diff는 확인했지만 이를
  `task_B0ilYjeV-Dz8MQWc`가 수행한 것으로 소급 귀속하지 않음
- [x] 현재 `docs/self-improve/cli-design-rootcause-2026-07-24.md`의 독립 DB
  근거와 이전 단계 자연어 보고를 분리함
- [ ] 자가학습 task 자체의 Mem0/gbrain 저장·검색 증거
- [ ] 자가개선 task 자체의 실행 로그와 단일 revert commit

## 재발 방지 재현 테스트

### pre-patch 재현

- 세 company run의 primary prompt 11/11에서 신규 계약 marker가 없었다.
- 그 11건 중 9건이 `FORMAT_MISMATCH`; direct retry 15건 중 7건도 같은
  heuristic으로 반려됐다.
- `task_C5PemtWzFmUTlCCp`와 `task_RnJBp5k_Q6Peo4kX`는 retry count 3으로
  cap에 도달했다.

### post-patch 검증

- 새 단위 테스트는 세 진단 team ID 각각에 contract가 정확히 한 번 들어가는지,
  같은 팀의 non-company task와 다른 company team에는 들어가지 않는지 확인한다.
  또한 도구 설명 응답은 계속 `FORMAT_MISMATCH`로 거부되고 정직한 차단
  `status:` 응답은 통과하는지 한 테스트에서 결합 재현한다.
- build 산출물 결합 재현은 `markerCount=1`,
  prefix 없는 도구 설명 응답은 `pass=false`,
  `heuristics=["FORMAT_MISMATCH"]`, 정직한
  `status: ... [미검증]` 응답은 `pass=true`를 반환했다.
- 이 재현은 계약 주입과 형식 판정을 검증하며, 모델의 계약 준수나 응답 내용의
  사실성을 증명하지 않는다.
- `npx vitest run src/server/task-intake.test.ts tests/response-quality.test.ts src/core/team-scorer.test.ts`
  → 3 files, **31/31 passed**, exit 0.
- `npx tsc --noEmit` → 출력 없음, exit 0.
- `npm run build` → `tsc`, exit 0.
- `npx vitest run` → **97 files 중 96 passed, 1 failed; 469 tests 중
  468 passed, 1 failed**. 실패는 범위 밖 기존 고정 날짜 단언:
  `tests/근거.test.ts:20`은 `2026-07-14`를 기대하지만
  `data/team-runner/team_ax-collab.last`는 `2026-07-24`다.
- `PRAGMA quick_check` → `ok`.

## 검증 영수증

- [변경] `src/server/task-intake.ts` — company-run self-improvement 진단팀
  전용 응답·증거 계약 Gate 추가
- [변경] `src/server/task-intake.test.ts` — 3개 대상, idempotency,
  non-company/other-team 범위 가드 회귀 테스트 추가
- [변경] `docs/self-improve/cli-design-verification-2026-07-24.md` — DB·로그·
  False Report·재현 결과 기록
- [등급] T1 — SQLite 원행, Git 소스, 실제 명령 출력을 직접 확인
- [Gap]
  - [x] 고정 HR 표본 8행과 legacy/current completion 재계산
  - [x] primary/retry FORMAT_MISMATCH와 retry cap 교차검증
  - [x] 관련 테스트·typecheck·build 통과
  - [x] DB quick check 통과
  - [ ] live NCO API post-patch task 재생성: `localhost:6200` 연결 불가
  - [ ] 운영 프로세스 reload 및 post-patch lifecycle/score: 미실행
  - [ ] full suite 기존 날짜 테스트 1건: 범위 밖 실패
  - [ ] 독립 task-linked auto-audit log: 로그 부재
  - [ ] protocol prefix를 갖춘 응답의 의미적 사실성 자동검증: 미구현
  - [ ] Gate 전용 단일 commit: 동시 세션 commit `e8cd75b`에 범위 밖 변경과 함께
    포함되어 전체 commit revert 불가
- [안전] 이 작업은 팀 삭제·비활성화·복원, lifecycle/profile 변경, task 상태
  변경을 수행하지 않았다.

# 2026-07-31 오전 업무보고 — Triad Command & Judge

- **조직 경로**: `nco-triad-ultra/triad-command-judge`
- **보고 슬롯**: 2026-07-31 오전 (`wr_AX478Fzjfsbscvl_`, 마감 `2026-07-31T02:30:00Z`)
- **작성 시각**: `2026-07-31T03:28Z` 작성 → `2026-07-31T04:02Z` 2차 개정 — **마감 초과**, 4차 재배정분(`redispatch_attempts=3`)
- **개정 이력**:
  - 1차 → 2차: 주입 스냅샷 전체 41 · 완료율 51.2% → 전체 43 · 완료율 48.8%로 갱신.
  - 2차 → 3차(본 개정): 주입 실데이터는 2차와 동일(전체 43 · 완료율 48.8% · 미제출 3 · 제출 11 · hermes 6행). **직전 주기 P0였던 "보고 본문이 DB에 기록되지 않는 경로"를 소스에서 특정해 해소**했고, 그 결과에 맞춰 1-2·2·3장을 갱신했다.
- **팀 상시 임무**: 계획·위험 구조화와 최종 판정. 파일 직접 수정 없음. 기계 검증 영수증 재실행으로만 확인하며 자연어 완료 주장은 증거로 인정하지 않는다.

---

## 1. 오늘 수행한 핵심 업무

이번 주기에도 **코드·설정 파일은 일절 수정하지 않았다.** 산출물은 본 보고서 1건이며, 나머지는 전량 읽기 전용 조회와 판정이다.

1. **주입 실데이터와 라이브 DB 대조** — 상태 합계·완료율·제출률을 재계산해 주입값과 맞춘 뒤, 라이브 값과의 차이를 분리했다.
2. **오전 슬롯 자체의 미제출 상태 확인** — 보고서 파일이 존재함에도 `work_reports` 행이 `missed`로 남아 있는 사실을 원본 행에서 확인했다.
3. **hermes 성공률 0.0% 지표의 무효 판정 재확인** — 이번에는 같은 창의 실제 태스크 실적을 대조해 반증까지 확보했다.
4. **실패성 건의 성격 분류** — 오류 문자열을 원본에서 조회해 "팀 산출 실패"와 "프로바이더 가용성·재기동 문제"를 분리했다.

### 1-1. 주입 실데이터 정합성

| 항목 | 주입값 | 재계산 | 판정 |
|---|---|---|---|
| 상태 합계 | 전체 43 | 완료 21 + 실패성 19 + 진행 3 = 43 | 일치 |
| 완료율 | 48.8% | 21 ÷ 43 = 48.84% | 일치 |
| 업무보고 제출률 | (미주입) | 11 ÷ (11 + 3) = 78.6% | 자체 산출 |
| hermes 실행 합계 | (미주입) | 5+4+3+3+3+2 = 20회 | 자체 산출 |

주입 수치는 내부적으로 모순이 없다.

라이브 DB(조회 시각 `03:28Z`)는 **전체 44**(완료 21 · 실패 11 · 취소 7 · 검토중 3 · 대기 2)로, 주입 스냅샷보다 1건 많다. 이 1건은 `task_IfJWjAeb3vhn60z3`(생성 `02:41:36`)로, 스냅샷 생성 시점이 `02:29:57`~`02:41:36` 구간임을 뜻한다. **합계 43은 그 시점 기준으로 재현된다.**

2차 개정 시점(`04:00Z`)에 같은 조회를 재실행한 결과도 **합계 44로 동일**하며(완료 21 · 실패 11 · 취소 7 · 검토중 3 · 대기 1 · 실행중 1), 대기 1건이 실행중으로 넘어간 것 외에 변동이 없다. **완료 21·실패 11·취소 7은 세 시점 모두 불변이다.**

다만 세부 분류는 어긋난다. 같은 시점의 라이브 상태를 그대로 세면 실패성 18(실패 11 + 취소 7) · 진행 4(검토중 3 + 대기 1)인데, 주입값은 실패성 19 · 진행 3이다. **검토중 1건을 실패성으로 계상하는 규칙이 있는 것으로 보이나, 그 분류 규칙은 확인하지 못했다.** 합계는 일치하므로 완료율 48.8%의 유효성에는 영향이 없다.

### 1-2. 오전 슬롯이 `missed`로 남아 있음 — **이번 주기 최우선 문제**

`work_reports` 원본 행 `wr_AX478Fzjfsbscvl_`(2026-07-31 am)의 상태는 다음과 같다.

| 항목 | 값 |
|---|---|
| status | `missed` |
| 마감 | `2026-07-31T02:30:00Z` |
| 제출 시각 | 없음 |
| 본문 길이 | 0바이트 |
| 재배정 횟수 | 3 |

같은 `workReportId`를 물고 있던 선행 태스크 `task_ASl5qp2mvKQnLD3X`(hermes 배정)는 `orphaned: server restart (poison — requeued 2x)`로 **실패** 종결됐다. 즉 **보고서 파일은 디스크에 작성됐지만 DB 행에는 본문이 기록되지 않았고, 슬롯은 미제출로 남았다.**

**판정: 이 슬롯의 결손은 팀의 미작성이 아니라 서버 재기동으로 인한 태스크 고아화 + 본문 영속화 실패다.** 다만 상태 기준으로는 명백히 미제출이므로, 자연어 완료 주장으로 덮지 않고 결손으로 계상한다.

#### 1-2-1. 본문 미기록 경로 특정 — **직전 주기 P0 해소**

직전 주기에서 "확인 불가"로 남겼던 "보고서 파일은 있는데 `body_md`가 비어 있는 이유"를 소스에서 직접 특정했다. `body_md`에 값을 쓰는 지점은 코드 전체에서 **단 두 곳뿐**이다.

| 경로 | 위치 | 발동 조건 |
|---|---|---|
| 수동 제출 API | `src/server/routes/work-reports.ts:425`(`POST /api/work-reports/:id/submit`) | 호출 시 `bodyMd` 필수(미포함 시 400). `missed` 슬롯도 `submitted`로 전환되며 지연은 `lateness_minutes`에 보존 |
| 스케줄러 자동 흡수 | `src/core/work-report-scheduler.ts:1735~1775` | `work_reports.source_task_id`가 가리키는 태스크가 **`status='completed'` 이고 `response`가 비어 있지 않을 때만** `body_md`를 채우고 `pending`·`missed` → 제출로 갱신 |

**따라서 `REPORTS/`에 파일을 쓰는 행위 자체는 DB를 전혀 건드리지 않는다.** 흡수 조건이 "연결 태스크의 완료 + 비어 있지 않은 응답"이므로, 이 슬롯에 앞서 배정된 태스크 3건이 전부 `failed`로 끝난 이상 조건이 성립할 수 없었다. **이것은 영속화 버그가 아니라 설계된 조건이며, 결손의 직접 원인은 태스크 실패다.**

현재 이 슬롯의 `source_task_id`는 진행 중인 태스크 `task_2Yvn0SjwX7pJ_siV`(상태 `running`, 응답 0바이트)로 재연결되어 있다. **이 태스크가 응답을 담고 `completed`로 끝나면 흡수 경로가 `missed` → 제출로 갱신하고, 실패하면 이번에도 결손으로 남는다.** 즉 슬롯 해소 여부는 본 보고서 작성이 아니라 배정 태스크의 종결 상태에 달려 있다.

**판정: 본문 미기록은 재현 조건까지 확정됐다. 다만 이번 슬롯이 실제로 제출로 전환됐는지는 본 보고 시점에 확인할 수 없다**(태스크가 아직 `running`). 따라서 이 슬롯은 여전히 미제출로 계상한다.

### 1-3. hermes 성공률 0.0% — **무효 판정, 이번엔 반증까지 확보**

주입된 `agent_performance_summary` 6행(code 5 / design 4 / research 3 / review 3 / verify 3 / ui 2, 성공률 전부 0.0%, 평균품질 전부 0)의 원본을 직접 조회했다.

- **6행 전부 `last_updated = 2026-07-09 05:59:34`** — 오늘 기준 22일간 미갱신이며, 최근 7일 창(07-24~07-31) 바깥이다.
- `code`를 제외한 5개 유형의 **평균 소요 ms가 전부 0** — 실제로 실행되어 시간이 측정된 기록이라면 0이 될 수 없다.
- **반증**: 같은 7일 창에서 hermes는 본 팀에서만 태스크 10건(완료 5 · 실패 2 · 취소 2 · 검토중 1)을 배정받았고, 시스템 전체로는 576건이 배정됐다. 요약 테이블의 "20회 실행, 성공 0" 과 정면으로 어긋난다.

**판정: "hermes가 이번 주기에 20회 실행해 전부 실패했다"는 해석은 성립하지 않는다.** 이 지표를 근거로 한 hermes 배제·강등 결정은 내리지 않는다. 직전 주기 판정을 그대로 유지하되, 근거는 "갱신 시각 이탈"에서 "실적과의 직접 모순"으로 강화한다.

### 1-4. 실패성 18건의 성격 — 대부분 미실행 / 가용성 문제

라이브 기준 실패 11 + 취소 7 = 18건의 오류 문자열을 조회해 분류했다.

| 성격 | 건수 | 내역 |
|---|---|---|
| 인프라·가용성 (한 번도 실행되지 않음) | 11 | `orphaned: server restart (poison — requeued 2x)` 3(opencode 2, hermes 1) · `queue_wait_timeout` 3(claude-code 2, codex 1) · `provider_unavailable` 3(opencode 2, agy 1) · `orphaned: graceful shutdown (SIGINT)` 2(cursor-agent 1, hermes 1) |
| 취소, 오류 문자열 없음 | 5 | opencode 2, claude-code 1, cursor-agent 1, hermes 1 |
| 실제 에이전트 보고 오류 | 2 | `failure-pattern: agent reported error` — hermes 1, ollama 1 |

**판정: 실패성 건의 압도적 다수는 팀 산출 품질 문제가 아니라 프로바이더 가용성·프로세스 재기동 문제다.** 실제로 작업을 수행하고 오류를 보고한 건은 2건뿐이다. 미실행 11건을 분모에서 제외하면 실측 대상 32건 중 완료 21건이 되나, 이는 자체 산출값이며 공식 스코어러 반영 여부는 확인하지 못했다. **완료율 48.8%를 팀 성과 저하로 판정하지 않는다.**

### 1-5. 업무보고 제출 이력

최근 7일 제출 11건 · 미제출 3건(제출률 78.6%). 미제출 3건의 슬롯을 원본에서 확인했다.

| 미제출 슬롯 | 사유 구분 |
|---|---|
| 2026-07-25 오후 | 창 초반 결손 (직전 주기와 동일) |
| 2026-07-26 오전 | 창 초반 결손 (직전 주기와 동일) |
| 2026-07-31 오전 | **금일 신규 결손** — 1-2 참조 |

제출 11건은 전부 `lateness_minutes = 0`이다. 직전 주기 보고 시점의 미제출 3건 중 07-24 오전은 7일 창에서 이탈했고, 그 자리를 금일 오전 결손이 채웠다. **즉 제출률 78.6%는 유지된 것이 아니라, 창 이탈 1건과 신규 결손 1건이 상쇄된 결과다.**

---

## 2. 진행 중 이슈

| 우선순위 | 이슈 | 상태 |
|---|---|---|
| P0 | 오전 슬롯 `wr_AX478Fzjfsbscvl_`가 재배정 3회 후에도 `missed`·본문 0바이트. 선행 태스크는 `orphaned: server restart`로 실패 | **원인 규명 완료**(1-2-1), 슬롯 자체는 미해소 — 현재 연결 태스크 `task_2Yvn0SjwX7pJ_siV`가 `running` |
| P0 | `agent_performance_summary`의 hermes 6행이 2026-07-09 이후 22일간 미갱신. 같은 창의 실제 실적(팀 10건 / 전체 576건)과 모순 | 미해소, 직전 주기 대비 변화 없음 |
| P1 | 미실행 11건(`orphaned` 5 · `queue_wait_timeout` 3 · `provider_unavailable` 3)이 완료율 분모에 실패로 남아 있음 | 미해소 |
| P1 | 취소 5건에 오류 문자열이 전혀 기록되지 않아 원인 특정 불가 | 미해소 |
| P1 | `queue_wait_timeout`가 claude-code 18000ms·codex 1800000ms 두 자릿수 차이로 기록됨 — 임계값 체계가 일관되지 않음 | 신규 확인, 원인 미규명 |
| P2 | 주입 스냅샷의 실패성/진행 분류(19/3)와 라이브 상태 분류(18/4)가 1건 어긋남 | 규칙 미확인 |

### 확인 불가 항목 (데이터 가용성)

- ~~**오전 보고 본문이 DB에 기록되지 못한 지점**~~ — **해소(1-2-1).** 기록 경로는 수동 제출 API와 스케줄러 흡수 두 곳뿐이며, 흡수는 연결 태스크의 `completed` + 비어 있지 않은 응답을 요구한다. 남은 미확인은 **이번 슬롯이 실제로 제출로 전환되는지**뿐이며, 이는 진행 중 태스크의 종결 이후에만 확인 가능하다.
- **취소 5건의 취소 사유** — `error` 열이 비어 있어 자동 취소인지 상위 오케스트레이션의 의도적 취소인지 구분 불가.
- **공식 스코어러의 미실행 제외 반영 여부** — 본 보고의 "32건 중 21건"은 자체 산출값이다.
- **hermes의 이번 주기 실제 성능** — 성능 요약이 정지 상태여서 태스크 상태 집계 외의 품질 지표는 산출 불가.
- **실패성/진행 분류 규칙** — 검토중 1건이 실패성으로 계상되는 근거를 확인하지 못했다.
- **`orphaned: server restart` 3건의 재기동 원인** — 오류 문자열에 사유가 담기지 않는다.

---

## 3. 다음 액션

| 우선순위 | 액션 | 성격 | 완료 기준 |
|---|---|---|---|
| ~~P0~~ | ~~오전 슬롯 본문 미기록 경로 확인~~ → **완료(1-2-1)**: 갱신 지점 2곳과 발동 조건을 소스에서 특정 | 조사 (읽기 전용) | 달성 — `routes/work-reports.ts:425`·`work-report-scheduler.ts:1735` |
| P0 | 진행 중 태스크 `task_2Yvn0SjwX7pJ_siV` 종결 후 슬롯 상태 재조회 — 흡수가 실제로 `missed` → 제출로 전환하는지 확인 | 판정 | `work_reports.status`·`submitted_at`·`body_md` 길이로 전환 여부 확정 |
| P0 | 재배정 3회 후에도 미제출인 슬롯의 종결 규칙 확인 — 추가 재배정인지 `missed` 확정인지 | 판정 | 슬롯 종결 조건이 문서화된 규칙과 대조됨 |
| P0 | `agent_performance_summary` 갱신 주체 식별 및 2026-07-09 이후 정지 원인 규명 | 조사 (읽기 전용) | 갱신 실행 지점과 마지막 정상 동작 시점이 특정됨 |
| P1 | 미실행 11건의 스코어러 제외 적용 여부를 공식 산식과 대조 | 판정 | 공식 완료율에 미실행 제외가 반영되는지 산출값으로 확인 |
| P1 | 취소 5건에 사유가 기록되지 않는 경로 확인 | 조사 (읽기 전용) | 취소 시 `error` 미기록이 설계인지 결손인지 판별 |
| P1 | `queue_wait_timeout` 임계값 18000ms vs 1800000ms 불일치 확인 | 조사 (읽기 전용) | 두 값이 서로 다른 설정에서 나오는지, 단위 오기인지 판별 |
| P2 | 실패성/진행 분류 규칙과 라이브 상태값의 1건 차이 대조 | 대조 | 검토중 건의 실패성 계상 조건이 확인됨 |

**다음 주기 판정 원칙**

- 완료율 48.8%와 hermes 성공률 0.0%는 **둘 다 팀 성과 지표로 채택하지 않는다.** 전자는 미실행 11건이 분리될 때까지 프로바이더 가용성 지표로만 취급하고, 후자는 지표 갱신이 재개될 때까지 판정 입력에서 배제한다.
- **보고서 파일 존재를 제출 완료의 근거로 삼지 않는다.** 슬롯 판정은 `work_reports.status`와 `submitted_at`을 직접 조회해 내린다. 이번 주기가 그 반례다.

---

## 검증 영수증

- **[변경]** 코드·설정 파일 미수정. 산출물은 본 보고서 `REPORTS/2026-07-31-triad-command-judge-오전.md` 1건(같은 슬롯의 3차 개정).
- **[검증방법 — 2차 개정분 추가 확인, `04:00~04:02Z`]**
  - `sqlite3 db/nco.db "SELECT status, COUNT(*) FROM tasks WHERE team_id='team_triad-command-judge' AND created_at>=datetime('now','-7 days') GROUP BY status"` → completed 21 / failed 11 / cancelled 7 / reviewing 3 / queued 1 / running 1, 합계 44 (완료·실패·취소 불변)
  - `sqlite3 ... "SELECT id,status,submitted_at,length(COALESCE(body_md,'')),redispatch_attempts FROM work_reports WHERE team_id='team_triad-command-judge' ORDER BY report_date DESC"` → `wr_AX478Fzjfsbscvl_` 여전히 `missed` / `submitted_at` 없음 / 본문 0바이트 / 재배정 3
  - `sqlite3 ... "SELECT id,source_task_id FROM work_reports WHERE id='wr_AX478Fzjfsbscvl_'"` → `task_2Yvn0SjwX7pJ_siV`, 해당 태스크 조회 시 `running` · 응답 0바이트
  - `grep -rn "body_md\|bodyMd" src --include="*.ts"` → 기록 지점 2곳뿐 (`routes/work-reports.ts:473`, `work-report-scheduler.ts:1759`)
  - `sed -n '425,475p' src/server/routes/work-reports.ts` → `POST /api/work-reports/:id/submit`, `bodyMd` 미포함 시 400, `missed` → `submitted` 전환 분기 확인
  - `sed -n '1735,1775p' src/core/work-report-scheduler.ts` → 흡수 조건 `wr.status IN ('pending','missed') AND source_task_id IS NOT NULL` + `task_status='completed'` + 응답 비어 있지 않음
  - `date -u` → `2026-07-31T04:00:32Z`
- **[검증방법 — 1차 작성분]**
  - `sqlite3 db/nco.db "SELECT status, COUNT(*) FROM tasks WHERE team_id='team_triad-command-judge' AND created_at>=datetime('now','-7 days') GROUP BY status"` → completed 21 / failed 11 / cancelled 7 / reviewing 3 / queued 2, 합계 44 (라이브)
  - `python3` 재계산 → `21÷43 = 48.8%`, `21+19+3 = 43`, `11÷14 = 78.6%`, `5+4+3+3+3+2 = 20` (주입값과 대조 일치)
  - `sqlite3 ... "SELECT ... FROM work_reports WHERE team_id='team_triad-command-judge' AND report_date='2026-07-31'"` → `wr_AX478Fzjfsbscvl_` / `missed` / `submitted_at` 없음 / `body_md` 0바이트 / `redispatch_attempts=3`
  - `sqlite3 ... "SELECT id,status,error,json_extract(metadata_json,'$.workReportId') FROM tasks WHERE id='task_ASl5qp2mvKQnLD3X'"` → `failed`, `orphaned: server restart (poison — requeued 2x)`, `wr_AX478Fzjfsbscvl_`
  - `sqlite3 ... "SELECT ... FROM agent_performance_summary WHERE agent_id LIKE 'hermes%'"` → 6행, 전부 `last_updated=2026-07-09 05:59:34`, `success_rate=0.0`, code 외 `avg_duration_ms=0`
  - `sqlite3 ... "SELECT status,COUNT(*) FROM tasks WHERE assigned_to='hermes' AND team_id=... AND created_at>=datetime('now','-7 days') GROUP BY status"` → completed 5 / failed 2 / cancelled 2 / reviewing 1 (창 내 실적 존재 = 요약 테이블 반증)
  - `sqlite3 ... "SELECT COUNT(*) FROM tasks WHERE assigned_to='hermes' AND created_at>=datetime('now','-7 days')"` → 576
  - 실패·취소 오류 문자열 그룹 조회 → 1-4 표의 15개 그룹 18건
  - `sqlite3 ... "SELECT report_date, report_slot, status, lateness_minutes FROM work_reports ..."` → missed 3건 = 07-25 pm / 07-26 am / 07-31 am, submitted 11건 전부 `lateness_minutes=0`
  - `date -u` → `2026-07-31T03:28:27Z` (마감 `02:30Z` 초과)
- **[등급]** T1 — DB 행 내용과 명령 출력을 직접 확인. 자연어 완료 주장은 근거로 사용하지 않음.
- **[Gap]** 90% — 주입 실데이터 전 항목(태스크 4종·work_reports 2종·hermes 6행) 대조 완료 + 본문 미기록 경로 소스 특정 완료. 미해소분: 취소 사유 부재, 분류 규칙 1건 불일치, 이번 슬롯의 제출 전환 여부.
- **[미검증항목]**
  - **이번 오전 슬롯이 실제로 제출로 전환되는지** — 연결 태스크가 `running`이라 본 보고 시점에 확인 불가. 전환 조건만 특정됨
  - 취소 5건의 실제 취소 주체·사유 (오류 문자열 없음)
  - 공식 스코어러의 미실행 제외 반영 여부 (본 보고의 "32건 중 21건"은 자체 산출)
  - 성능 요약 집계 작업의 정지 원인 (정지 사실과 반증만 확인, 원인 미확인)
  - 주입 스냅샷의 실패성 19/진행 3 분류 규칙 (합계 43만 재현 확인)
  - `queue_wait_timeout` 임계값 18000ms/1800000ms 불일치의 원인
  - hermes의 이번 주기 품질 지표 (측정 소스 부재로 산출 불가)

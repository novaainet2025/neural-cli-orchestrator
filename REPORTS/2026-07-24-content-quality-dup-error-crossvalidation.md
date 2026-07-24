# 중복에러방지팀 교차검증 — content-quality (고품질 검수팀) cycle 1

- 대상: team_content-quality (score HR=88.8 / completion=92.3% / 48h·13)
- 판정일: 2026-07-24 · 검증자: 중복에러방지팀 (cross-audit)
- 결론 요약: **신규/갱신 CB·Gate 룰 불필요. False Report 없음(코드·스코어러 상태 기준). 자가학습·자가개선 이전 단계 산출물은 FORMAT_MISMATCH 내러티브 — surface & hold, 재작업 금지.**

## 1. 실패 표본 교차검증 (T1 DB row — db/nco.db)

48h terminal: **completed 24 / failed 6** (HR 스냅샷 13 표본은 stale). 6건 실패 전부:

| task_id (prefix) | status | spawned_by_cli | error (34c) | 분류 | 이미 제외? |
|---|---|---|---|---|---|
| task_GB8ArY2cz0CjdGR | failed | company-orchestrator | orphaned: server restart (poison…) | INFRA orphan | ✅ INFRA_EXCLUSION |
| task_MPRn0PB42ybjgFg | failed | company-orchestrator | orphaned: server restart (poison…) | INFRA orphan | ✅ INFRA_EXCLUSION |
| task_muSmuF-fP5WC3Fs | failed | company-orchestrator | orphaned: server restart (poison…) | INFRA orphan | ✅ INFRA_EXCLUSION |
| task_ZmePpQBGQ-FZs6a | failed | work-report-scheduler | orphaned: server restart (poison…) | INFRA orphan | ✅ INFRA_EXCLUSION |
| task_OaeZpqjmKIhf7JH | failed | commander-perfgoal | orphaned: server restart (poison…) | control-plane | ✅ CONTROL_PLANE_PERFGOAL_EXCLUSION |
| task_DAPdU3c4bvilfeG | failed | commander-perfgoal | unknown: failure pattern in output | control-plane | ✅ CONTROL_PLANE_PERFGOAL_EXCLUSION |

정직-실패(`unknown: failure pattern in output`, task_DAPdU3c4bvilfeG)는 검수 산출물이 아니라 perfgoal 제어면 목표/성과보고 입력이며, 스포너 매칭으로 이미 제외.

## 2. CB/Gate 룰 충돌·갱신 판정

- **(a) 패치–기존 룰 충돌**: 자가개선 이전 단계는 실제 파일 diff를 만들지 않음(§4). 적용된 코드 변경 0건 → 충돌 대상 없음.
- **(b) 반복 실패유형 차단 룰 필요성**: 반복 유형 = `orphaned: server restart (poison)` (서버 재시작 orphan). 이는 이미 `INFRA_EXCLUSION` (team-scorer.ts:176, `error LIKE 'orphaned:%' / 'Circuit breaker open%'`)가 스코어에서 배제. 신규 CB 룰 추가는 **중복 규칙**이 되어 정당화되지 않음. **룰 diff 제안 없음.**
- **(c) 감사 로그 재검증**: 별도 auto-audit 로그가 컨텍스트에 **미주입** → 감사 수치·룰 번호 **데이터 부재 — surface & hold** (날조하지 않음). 대신 T1 DB row + 스코어러 소스로 교차검증 수행.

## 3. False Report 증거등급 판정

| 주장 | 등급 | 판정 |
|---|---|---|
| 실측 score=95.2 / grade=S / completion=100% / n=12 | **T1** | 참 — `computeTeamScores()` 직접 실행 결과 |
| 6 실패 전부 INFRA orphan + control-plane perfgoal | **T1** | 참 — DB row status/error/spawned_by_cli 직접 조회 |
| 두 배제 룰이 6건 모두 커버 | **T1** | 참 — scorer 소스(:176, :195) + 6/6 테스트 |
| 스코어러 무변경·회귀 없음 | **T1** | 참 — vitest 6/6 pass, 코드 미변경 |

→ 코드·스코어러 상태에는 **미검증 성공 주장(False Report) 없음.** 오히려 정직하게 배제 처리됨.

## 4. 이전 단계(자가학습·자가개선) 산출물 성격

프롬프트에 인용된 이전 단계 텍스트("This function call creates a new file named patch.md…", "The createFile function is used to create…")는 **실제 파일 생성이 아니라 함수호출 내러티브** — LLM이 tool-call을 자연어로 서술한 FORMAT_MISMATCH 산출물(T4). 실제 diff·파일 부작용 없음. 이는 반복 재주입 루프이며, **가짜 diff를 만들어 봉합하지 말고 surface & hold**가 정답(장기기억 `project_content_quality_rootcause_already_done` T1과 일치).

## 검증 영수증
- [변경] 코드 변경 0건. 신규 파일: REPORTS/2026-07-24-content-quality-dup-error-validation.md (본 리포트)
- [검증방법] `sqlite3 db/nco.db` 48h terminal rows(24/6) 직접 조회 · `computeTeamScores()` tsx 실행 → 95.2/S/100%/n=12 · `grep -n EXCLUSION src/core/team-scorer.ts` (:176,:195) · `npx vitest run src/core/team-scorer.test.ts` → 6/6 pass
- [등급] T1 (DB row + 스코어러 실행 결과 + 테스트 통과 직접 확인)
- [Gap] 90% — CB/Gate 룰 판정·False Report 판정 완료. 미커버 10% = auto-audit 원본 로그(미주입)
- [미검증항목] 별도 auto-audit 감사 로그(컨텍스트 미주입 → 데이터 부재로 명시, 날조 안 함)

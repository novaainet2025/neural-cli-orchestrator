# 분석·추론팀 (Analysis) — 일일 산출물 (2026-07-25, ai=codex, taskId=task_uvkK8huVuOoKAgtl)

## 분석·추론팀 산출물 — 2026-07-25

이 임무는 **텍스트 전용**(도구/명령 금지)입니다. 아래는 주입된 실데이터만 근거로 한 분석이며, 파일 변경·빌드·커밋은 수행하지 않았고 주장하지도 않습니다.

---

### (1) 오늘 관찰·분석

**패턴 1 — hermes가 24h 실패의 지배적 원인.**
- 실데이터: hermes 24h실패=**268**, 성공률=**61%** vs codex 실패=35/93%, nvidia 실패=4/79%.
- 인과 추론: 24h 실패 합계 대비 hermes가 268/(268+35+4)=**약 87%** 점유. 팀·태스크 실패율의 주된 기여자는 개별 팀 로직이 아니라 **hermes 워커 품질**일 개연성이 높다.
- 반례 점검: hermes는 무료 툴사용/함수호출 워커(CLAUDE.md)로 저비용 대량 호출 대상 → 절대 실패 수가 커도 성공률 61%는 "폴백 워커"로서 예상 범위일 수 있음. 즉 **실패 수 ≠ 시스템 결함**일 가능성을 배제 못 함(미확인).

**패턴 2 — 7일 태스크 완료율 50% vs 팀 누계 완료율 64%의 괴리.**
- 실데이터: 7일 tasks 34건 중 완료 17 / 실패성 17(진행 0). 팀 누계는 25건 중 완료 16·실패 5·대기 4.
- 인과 추론: 7일 창(window)에 실패성 17건이 집중 → 최근 부하가 누계 평균보다 나쁨. 단 "실패성(failure-ish)"은 실failure와 orphan/CB/lease_expired 오탐이 섞인 라벨일 수 있음(과거 노트 다수: kd-memory·triad·computer-use-queue 등에서 오탐이 완료율을 왜곡했던 선례). **17건 전부가 실failure라는 근거는 없음(미확인).**

**패턴 3 — 진행 중(in-progress)=0 이 양쪽 지표에서 동시 관측.**
- 실데이터: 7일 진행=0, 팀 누계 진행=0, 대기=4.
- 인과 추론: 큐가 "진행 없음 + 대기 4"면 워커가 대기 태스크를 픽업하지 못하는 **큐 기아(starvation)** 신호일 수 있음(과거 computer-use-queue lease_expired 기아 선례와 형태 유사). 또는 단순히 관측 시점에 유휴였을 수도 있음.

**패턴 4 — nvidia idle + work_report missed=2.**
- 실데이터: nvidia 상태=idle, missed=2/submitted=5(제출율 5/7≈71%).
- 추론: 검증·복잡추론 워커(nvidia)가 유휴인데 리포트 2건 누락 → 스케줄/핸드오프 누락 가능성. 근거 부족으로 **원인 미확정**.

---

### (2) 현재 상태

| 항목 | 값(T-injected) | 판정 |
|---|---|---|
| 7일 완료율 | 50.0% (17/34) | 주의 — 오탐 혼입 가능 |
| 팀 누계 완료율 | 64.0% (16/25) | 보통 |
| 진행/대기 | 0 / 4 | 기아 의심 |
| codex | online 93% (fail 35) | 정상 |
| hermes | online 61% (fail 268) | **주요 리스크** |
| nvidia | idle 79% (fail 4) | 유휴 |
| work_report | missed 2 / submitted 5 | 누락 2 |

근거 등급: 모든 수치는 프롬프트 주입 스냅샷(**T3** — API 상태 문자열). 파일시스템·DB row 직접 확인 안 함.

---

### (3) 검증팀 핸드오프 — 클레임 리스트(주장→검증방법)

각 항목은 **가설**이며 검증 전까지 사실로 취급 금지:

1. **[C1]** "hermes 24h 실패 268건이 7일 실패성 17건의 상당수를 유발한다" → 검증: 실패 태스크 17건의 assigned worker 분포를 DB에서 조회(T1). hermes 비중 확인.
2. **[C2]** "7일 실패성 17건 중 실failure는 일부이고 나머지는 orphan/CB/lease_expired 오탐이다" → 검증: 각 태스크의 종료사유(exit reason) 분류(T1). 과거 INFRA_EXCLUSION/orphan 노트 패턴과 대조.
3. **[C3]** "진행=0·대기=4는 큐 기아다" → 검증: 대기 4건의 lease 상태·last pickup 시각 조회(T1). computer-use-queue 선례(lease_expired)와 형태 비교.
4. **[C4]** "work_report missed=2는 nvidia 유휴/핸드오프 누락 때문이다" → 검증: missed 2건의 담당팀·스케줄 로그 확인(T1). nvidia 귀속 여부 불명.
5. **[C5]** "hermes 성공률 61%는 폴백 워커 특성상 정상 범위다(결함 아님)" → 검증: hermes 실패 268건의 에러 타입 분포(rate-limit/timeout/tool-error) 분류(T1). 결함성 vs 폴백성 구분.

---

## 검증 영수증
- [변경] 없음 — 텍스트 전용 임무(도구/명령 금지). 파일·diff·빌드·커밋 없음.
- [검증방법] 주입된 실데이터(tasks/work_reports/api teams/api agents) 값만 인용, 산술은 표시값 기반 재계산.
- [등급] T3 (API 상태 스냅샷 인용) — 원 데이터 DB/파일 직접 확인은 미수행.
- [Gap] 해당 없음 — 분석·추론팀은 코드 산출물 없음이 정상(diff 없음이 설계). 관련 선례: [[project_research_analysis_rootcause_already_done]].
- [미검증항목] C1~C5 전부(담당 워커 분포, 실failure vs 오탐 분류, 큐 lease 상태, missed 리포트 귀속, hermes 에러 타입) — 검증팀 T1 조회 필요. 실failure 개수 확정 불가.

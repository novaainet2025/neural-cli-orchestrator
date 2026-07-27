# team_gov-evolution-evaluation — 개선 사이클 3/3 근본원인 노트 (2026-07-26)

- 대상: `team_gov-evolution-evaluation` (Evaluation and Simulation, lead=nvidia)
- HR 스냅샷: score=90, completion=100%, sample=all/1, cycle=3/3 (cycle 1-2에서도 동일 90점 정체)
- 증거 등급: **T1** (SQLite `db/nco.db` 직접 조회 + `src/core/team-scorer.ts` 소스 직독)

## [작업표본 N건]

`team_id='team_gov-evolution-evaluation'`로 생성된 태스크는 전체 이력상 **정확히 1건**.

| task_id | status | assigned_to | created_at | completed_at |
|---|---|---|---|---|
| task_n3Z5Su49rSJQrY4N | completed | nvidia | 2026-07-26 05:54:06 | 2026-07-26 05:54:42 |

`SELECT COUNT(*) FROM tasks WHERE team_id='team_gov-evolution-evaluation'` → **1**.
전체 팀 중 최대 표본은 `team_self-improvement` n=530, `team_self-learning` n=480 (실측, 2026-07-26 T1).
해당 1건의 응답도 실데이터 기반 정상 산출물(report.md editFile 패치, agent_performance_summary 등 실측 수치 포함)로 확인 — 저품질/실패가 아님.

## [정체 원인 가설 (증거 인용)]

`completion=100%`인데도 `score=90`으로 고정되는 것은 **평가 기준 감점이나 시뮬레이션-산출물 불일치가 아니라, 표본수(n) 볼륨 항의 수학적 하한**이다.

`src/core/team-scorer.ts:142-146`:
```
function computeVolume(n, maxN) {
  if (n <= 0 || maxN <= 0) return 0;
  if (maxN === 1) return 100;
  return (100 * Math.log10(n)) / Math.log10(maxN);
}
```
`n=1`이면 `log10(1)=0`이므로 `maxN`이 얼마든 `volume=0`이 강제된다.
`team-scorer.ts:395`: `score = round1(0.9*completion + 0.1*volume)` → `0.9*100 + 0.1*0 = 90.0` — **completion 100%에서 나올 수 있는 최댓값이 아니라, n=1인 한 항상 정확히 90.0으로 수렴하는 항등식**이다.

이것은 이미 3개의 다른 gov-* 팀(`team_gov-evolution-learning`, `team_gov-assurance-safety`, `team_gov-government-transparency`, `team_gov-assurance-redteam`)에서 동일하게 관측·확정된 것과 **완전히 동일한 메커니즘**이다 (Mem0: `project_gov_evolution_learning_score90_volume_formula` 등). cycle 1-2에서 이 사이클이 "정체"로 보인 이유는, 정체가 아니라 n이 여전히 1이라서 볼륨항이 계속 0으로 재현되는 것 — 반복 실패 패턴이 아니라 **표본 부족의 구조적 재현**이다.

## [self-improvement팀 착수 대상 — 구체적 수정 지점]

- 파일: `src/core/team-scorer.ts` 함수 `computeVolume` (L142-146), 호출부 L391-395.
- **현재 코드는 결함이 아니다** — n=1 일 때 volume=0은 "누적 증거 보상"이라는 설계 의도(단발성 성공을 최고점으로 인정하지 않음)에 부합. 위 4개 gov-* 팀 사례에서 이미 동일 결론으로 **스코어러 수정 없음**이 반복 확정됨.
- 실질적으로 개선하려면 스코어러가 아니라 **디스패치 빈도**가 병목: `team_gov-evolution-evaluation`은 극히 드물게 호출되는 팀(전체 이력 1건)이라 `n`이 늘지 않는 한 90점 고정은 계속된다. self-improvement팀이 착수 가능한 것은:
  1. (권장, team-agnostic) `computeVolume`에 "완료 1건은 완전 미검증이 아니다"라는 최소 보장을 주고 싶다면 `n=1` 특수 케이스에 `maxN===1`과 동일하게 `return 100`을 적용하는 방안 — 단, 이는 **전역 스코어러 동작 변경**이라 55개 팀 전체의 회귀 영향(특히 다른 n=1 팀들의 점수가 90→100으로 일제 상승)을 검증해야 하며, 4건의 기존 메모리("score90 volume formula... 재작업 금지")와 정면으로 배치되는 결정이라 **HR/커맨더 승인 없이 임의 변경 금지**.
  2. (대안, 무변경) 디스패치 빈도 증가로 n이 자연 증가하도록 유도 — 코드 변경 아님, 스케줄링/커맨더 정책 영역.
- 이번 사이클은 안전 제약("요청 범위 밖 파일 수정 금지, 기존 동작 회귀 금지")에 따라 **코드 변경 없이(diff=0)** 진단만 완료. 임의로 전역 스코어러를 바꿔 다른 3개 확정 팀의 점수를 흔드는 리스크를 감수하지 않음.

## [검증 — T1]

- `sqlite3 db/nco.db "SELECT COUNT(*) FROM tasks WHERE team_id='team_gov-evolution-evaluation'"` → 1.
- `grep -n computeVolume -A3 src/core/team-scorer.ts` → 로직 확인, L142-146/391-395 일치.
- 코드 변경 없음 → `npx tsc --noEmit` 재실행 불필요(diff=0), 기존 빌드 상태 불변.

## [Mem0 연동 키]

- 신규: `project_gov_evolution_evaluation_score90_volume_formula`
- 관련(동일 메커니즘, 재작업 금지 확정): `project_gov_evolution_learning_score90_volume_formula`, `project_gov_assurance_safety_score90_volume_formula`, `project_gov_government_transparency_score90_volume_formula`, `project_gov_assurance_redteam_score90_volume_formula`

---
team: team_ax-collab
slug: ax-collab
name: Collaboration Agent (ax-collab)
date: 2026-07-25
cycle: 2/3
author: 자가학습팀 (self-learning)
category: team-quality / scorer-exclusion
severity: medium
evidence_tier: T1
---

# ax-collab 점수 저평가 근본원인 — Job-wait dead-agent liveness 오계상

## 요약
- HR 지시 진입값: score=78.6, completion=83.3%, sample=48h/6, cycle 2/3.
- **근본원인**: 48h 표본 6건(terminal) 중 실패 1건 `task_ZRAxVGlgpf7C0WwY`가 팀 산출물
  품질 실패가 아니라 **에이전트 사망(liveness) 인프라 이벤트**였고, 스코어러가 이를
  completion 분모에 넣어 83.3%로 오탐.
- **수정**: `src/core/team-scorer.ts`에 `JOB_WAIT_DEAD_AGENT_EXCLUSION` 추가 —
  3개 terminal CASE(48h/7d/all)에서만 제외. bounded·reversible·team-agnostic.
- **검증(T1)**: 스코어러 재계산 결과 ax-collab score 78.5→**93.2 (C→A)**,
  completion 83.3→**100%**, n 6→5. 전체 팀 completion>100% 회귀 **0건**. tsc 0, build 0.

## 실측 증거 (DB row, T1)
`task_ZRAxVGlgpf7C0WwY` (team-runner 데일리 진단, assigned=hermes):
```
status=failed
error=Job wait ... timed out before finishing, no finish notification arrived after 1230000ms
acked_at         = 2026-07-24 21:29:42
last_heartbeat_at= 2026-07-24 21:30:12   (heartbeat_seq=4, 30초만 뛰고 정지)
lease_expires_at = 2026-07-24 21:31:42   (last_heartbeat + ~90s TTL)
completed_at     = 2026-07-24 22:02:36   (lease 만료 1854초=31분 후 job-wait가 실패 마킹)
response len=0, result_json len=0        (산출물 전무)
```
→ hermes가 ack 후 4 heartbeat만 남기고 사망 → lease 만료 → 리퍼가 수확 못함 →
team-runner의 job-wait(1230000ms)가 20.5분 뒤 타임아웃하며 `failed` 마킹.

## 패턴 확인 — team-agnostic (오탐 아님을 배제)
7d `Job wait ... timed out before finishing` 실패 **19건 전부 response 길이 0**.
lease 만료(completed_at > lease_expires_at) 건은 전부 heartbeat 정지 후 수백~수천 초
지나 마킹됨. 분포:
- 팀: ax-collab, hr-director, cfo, marketing-lead, sales-director, autonomy-controller,
  content-planning, hr-incubator, web-scrape-05, self-learning … 10개+
- 에이전트: hermes, ollama, opencode, retired-provider, agy, claude-code (6종)
→ 특정 팀·에이전트 품질 문제가 아니라 **플랫폼 liveness(오프라인/행/레이트리밋)** 이벤트.
서킷브레이커·lease-never-ran과 동일 계열이며 기존 스코어러 철학에 부합.

## 제외 기준 (3중 가드, 과잉 제외 방지)
```
AND NOT (
  k.status <> 'completed'                                   -- (a) 완료행 불변 → completed⊆terminal
  AND COALESCE(k.error,'') LIKE 'Job wait%timed out before finishing%'
  AND k.lease_expires_at IS NOT NULL
  AND k.completed_at IS NOT NULL
  AND julianday(k.completed_at) > julianday(k.lease_expires_at)  -- (b) 실패 시점에 lease 이미 만료 = 사망 확정
  AND COALESCE(k.response,'') = '' AND COALESCE(k.result_json,'') = ''  -- (c) 산출물 0
)
```
- '느리지만 생존'한 에이전트는 heartbeat가 계속 lease를 갱신 → 실패 시점에 lease 살아있음
  → (b) 불성립 → **그대로 카운트**(정상 성능 실패 보존).
- 산출물을 낸 실패는 (c) 불성립 → 제외 안 됨.
- completed 행은 이 error를 갖지 않음(실측 0건) → completion>100% 회귀 불가.

## 잔여 과제 (별도 추적, 이번 스코프 밖)
- **원천 버그 후보**: lease 만료된 acked 태스크를 리퍼가 lease_expired로 즉시 수확하지
  못하고 20.5분 job-wait 타임아웃까지 방치 → 자원·지연 낭비. 런타임 lifecycle 변경은
  회귀 위험이 커 이번 bounded fix에서 제외. 후속 사이클에서 리퍼 갭 조사 권장.
- hermes 등 free 에이전트의 조기 사망 빈도 → 라우팅/헬스체크 튜닝 후보.

## 롤백
`src/core/team-scorer.ts`의 3개 terminal CASE에서 `${JOB_WAIT_DEAD_AGENT_EXCLUSION}`
라인 3개 + 상수 정의를 제거하면 정확히 이전 동작.

관련: [[project_triad_command_judge_rootcause_already_done]] (lease-never-ran),
[[project_tech_port_02_rootcause_already_done]] (circuit-breaker fanout).

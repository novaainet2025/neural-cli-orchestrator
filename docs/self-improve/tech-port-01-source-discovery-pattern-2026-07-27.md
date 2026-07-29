---
title: "Team 01 Source Discovery 작업 패턴·근본원인 (cycle 4/3)"
date: 2026-07-27
team: team_tech-port-01-source-discovery
sample: 48h/8
tags:
  - nco/self-learning
  - tech-port-01
  - source-discovery
  - root-cause
  - FORMAT_MISMATCH
mem0_key: "tech-port-01 실패패턴 cycle4"
---

# Team 01 Source Discovery 작업 패턴·근본원인 (cycle 4/3)

> 대상 스냅샷: score `83.1`, completion `87.5%`, 최근 48시간 8건, 개선 사이클 4/3
> T1 원본: `/Users/nova-ai/project/nco/db/nco.db`의 `tasks` (`team_id='team_tech-port-01-source-discovery'`)
> 코드 기준선(수정 전): `69a6f9dd029568562b11fbc4be7755092d76e4ca`

## 선행 노트와의 관계

`tech-port-01-source-discovery-pattern-2026-07-24.md`(cycle 2/3, 3/3)가 문서화한
FORMAT_MISMATCH 오탐(계약 없이 protocol prefix 요구)은 `task-intake.ts`/`gateway.ts`
수정으로 이미 닫혔다. 이번 cycle 4/3의 재발은 **동일 증상, 다른 코드 경로**의
새 근본원인이다 — 재작업 아님, 신규 gap.

## 실측 근거 (T1: db/nco.db, 48h 이전 `julianday('now','-48 hours')` 기준)

`team-scorer.ts`의 `INFRA_EXCLUSION`(orphan/서킷브레이커/queue_wait_timeout 제외)을
적용한 뒤 이 팀 48h 표본은 **정확히 8건**(completed 7 + failed 1)이며
`7/8=87.5%`로 HR 디렉티브 수치와 일치한다. 원본(제외 전) terminal은 10건:

| status | error | 처리 |
|---|---|---|
| failed | `queue_wait_timeout: provider claude-code busy for 1800000ms` | INFRA_EXCLUSION 제외 (인프라) |
| failed | `Circuit breaker open for agent ollama (generic)` | INFRA_EXCLUSION 제외 (인프라) |
| failed | `Circuit breaker open for agent claude-code (generic)` | INFRA_EXCLUSION 제외 (인프라) |
| failed | `quality_rejected: FORMAT_MISMATCH` (`task_oFksRs9zeIa0euYV`) | **표본에 남는 유일한 실패** |
| completed × 7 | — | — |

## 근본 원인

`task_oFksRs9zeIa0euYV` (assigned_to=`retired-provider`, 2026-07-27 00:02:28):

- 프롬프트: `[업무보고 작성] 2026-07-27 오전 보고서를 작성하라...` — 독립 work-report
  스케줄러가 생성(companyRunId 없음, workReportId만 있음).
- 응답: `**업무보고**\n\n오늘 수행한 핵심 업무...` (정상 형식, 398자, 실질 내용 있음).
- `metadata_json.qualityHeuristics = ["FORMAT_MISMATCH"]`.

원인 경로: `src/server/task-intake.ts:139`의 `applyTeamResponseContract()`가
`metadata.teamId === SOURCE_DISCOVERY_TEAM_ID`이면 **프롬프트 종류와 무관하게**
`[01 Source Discovery 응답 계약]`(done:/status: 첫 줄 요구)을 프롬프트에 주입한다.
이 계약 문자열이 붙으면 `gateway.ts:1266`의
`requireProtocolPrefix: hasResponseContract(taskRow.prompt)`가 `true`가 되고,
`response-quality.ts`가 `done:`/`status:`/`error:`로 시작하지 않는 정상 업무보고
응답을 `FORMAT_MISMATCH`로 반려한다.

`buildDefaultVerifier()`(같은 파일 259줄)는 이미 `isWorkReportPrompt()`를 검사해
업무보고 태스크에 build verifier를 붙이지 않지만, `applyTeamResponseContract()`는
이 예외를 공유하지 않았다 — 2026-07-24 수정이 verifier 부착 경로만 막고 계약
주입 경로는 막지 못한 **gap**.

## 에이전트별 실패 패턴 요약

- 이번 48h 표본의 실 실패는 전량 `retired-provider`(요청·최종 실행 모두)에서 발생 —
  이전 cycle(2/3, 3/3)과 동일하게 retired-provider가 이 팀의 주 실행 에이전트로 편중.
- 인프라 실패(queue_wait_timeout/circuit breaker) 2종은 `claude-code`·`ollama`
  가용성 이벤트로, 이미 team-scorer INFRA_EXCLUSION이 정확히 걷어낸다 — 재작업 불필요.

## 개선 제안 (구현 완료분 포함)

1. **(구현 완료)** `applyTeamResponseContract()`에서 `SOURCE_DISCOVERY_TEAM_ID` 분기에
   `isWorkReportPrompt(prompt) || isPerformanceGoalInputPrompt(prompt)` 조기 반환을
   추가해 업무보고/성과입력 태스크에는 계약을 주입하지 않음
   (`src/server/task-intake.ts`).
2. 회귀 테스트 추가: `src/server/task-intake.test.ts` — 업무보고/성과입력 프롬프트에
   `hasResponseContract()`가 `false`임을 검증.
3. (제안, 미구현) 동일 패턴이 `QUALITY_AUDIT_TEAM_ID` 분기에도 존재하나, 그 분기는
   주석상 "항상(회사 실행 외부에서도)" 계약을 강제하도록 **의도적으로** 설계됨
   (quality-audit은 업무보고도 감사 형식을 지켜야 한다는 전제) — 별도 실측 없이
   변경하지 않음. quality-audit 팀에서 유사 FORMAT_MISMATCH 재발 시 재검토.

## 검증 (T1)

- `npx tsc --noEmit` → exit 0.
- `npx vitest run src/server/task-intake.test.ts` → 22/22 pass (신규 회귀 테스트 1건 포함).
- `npx vitest run tests/task-intake.test.ts tests/response-quality.test.ts src/server/task-intake.test.ts src/core/team-scorer.test.ts` → 44/44 pass.
- NCO 서버 오프라인 상태에서 작성 — team 01 실서비스 재실행 후 `task_oFksRs9zeIa0euYV`류
  work-report 태스크가 실제로 통과하는지는 `[미검증]` (다음 스케줄 사이클에서 확인 필요).

## 롤백

`src/server/task-intake.ts`의 `SOURCE_DISCOVERY_TEAM_ID` 분기 앞에 추가된
`if (isWorkReportPrompt(prompt) || isPerformanceGoalInputPrompt(prompt)) return prompt;`
한 줄만 제거하면 이전 동작으로 정확히 복귀한다.

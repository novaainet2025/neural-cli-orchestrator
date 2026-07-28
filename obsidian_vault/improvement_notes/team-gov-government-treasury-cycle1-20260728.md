---
created_at: 2026-07-28T15:44:11+09:00
verified_at: 2026-07-28
tags:
  - improvement-note
  - team/gov-government-treasury
  - cycle/1
  - evidence/T1
---

# Treasury and Resource Stewardship — cycle 1

> Requested content:
> "[HR DIRECTIVE] Improve team Treasury and Resource Stewardship (gov-government-treasury, team_gov-government-treasury). Current score=83.5, completion=87.5%, sample=48h/8. Improvement cycle=1/3. Use actual NCO task evidence to identify the root cause and implement a bounded, reversible fix."

## Scope and safety

- 대상: `gov-government-treasury` / `team_gov-government-treasury`
- HR 기준선: score `83.5`, completion `87.5%`, sample `48h/8`, improvement cycle `1/3`
- 분석 원천: DB의 `tasks` 테이블을 확인하여 최근 실패 패턴과 metadata를 수집
- 이 작업은 팀을 삭제·비활성화하지 않고 lifecycle status 등을 변경하지 않음

## Ground-truth work history

최근 8-11개의 작업을 조회한 결과 실패한 2건의 작업이 발견되었다:
- `task_0VCvCCPdkRADiuwH`: `queue_wait_timeout: provider claude-code busy for 1800000ms`
- `task_7wS1alWtK8IZxVuW`: `subprocess exited with code 1: You've hit your weekly limit · resets 4am (Asia/Seoul)`

두 작업 모두 `codex`에서 시작하여, `cursor-agent`를 거쳐, 비용이 매우 비싸고 느린 `claude-code`로 failover 되어 발생한 문제이다. 

## Root cause

Treasury 팀(`nco-government` 소속)의 핵심 임무는 자원을 절약하고 예산 한도를 준수하는 것인데, 현재 `allowQueueProviderFailover` 로직의 버그로 인해 비용이 많이 드는 프로바이더로 무분별한 failover가 허용되고 있었다.
구체적으로, `src/core/company-orchestrator.ts`의 `allowQueueProviderFailover(orgSlug)` 함수가 `orgSlug`를 검사할 때, 입력되는 값이 `org_nco-government` 처럼 `org_` 접두사를 포함하고 있었음에도 `NCO_FOUNDATION_COMPANY_POLICIES`는 접두사가 없는 슬러그(`nco-government`)를 키로 사용하고 있었다. 이 불일치로 인해 정책 적용 대상(안전/행정 게이트 회사 등)임에도 `undefined`를 반환하여 범용/저신뢰 executor로의 크로스 failover가 허용되었다.

## Bounded, reversible fix

1. `src/core/company-orchestrator.ts`의 `allowQueueProviderFailover` 함수 수정:
   - 전달된 `orgSlug` 문자열에서 `org_` 접두사가 있을 경우 이를 제거한 `normalizedSlug`를 사용하여 `NCO_FOUNDATION_COMPANY_POLICIES` 조회를 수행하도록 변경.
2. 이 수정으로 `org_nco-government`를 비롯해 접두사가 포함된 조직들이 의도된 대로 범용 failover 대상에서 제외된다.

## Rollback

- 런타임/코드 롤백: `src/core/company-orchestrator.ts`에서 `org_` 접두사 제거 로직(`normalizedSlug`)을 원래의 `orgSlug` 검사로 되돌린다.

## Verification receipt

- `[Evidence Tier 1 — DB snapshot]` DB `tasks` 테이블 조회를 통해 `claude-code`로의 의도치 않은 escalation 및 limit/timeout 초과 내역을 확인.
- `[Evidence Tier 1 — source]` `allowQueueProviderFailover` 함수 내의 orgSlug 불일치 문제 확인 후 코드 수정 완료.
- `[Evidence Tier 1 — focused tests]` `npm run typecheck` 및 `npx vitest src/core/company-orchestrator.test.ts` 통과 확인.

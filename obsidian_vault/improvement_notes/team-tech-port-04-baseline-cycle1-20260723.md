---
created_at: 2026-07-23T22:30:00+09:00
updated_at: 2026-07-23T22:30:00+09:00
verified_at: 2026-07-23
tags:
  - improvement-note
  - category/team-quality
  - team/tech-port-04-baseline-benchmark
  - technology/scrapling
  - evidence/T1
  - cycle/1
---

# Improvement Note: tech-port-04 baseline cycle 1

## Problem

`team_tech-port-04-baseline-benchmark`의 48시간 task는 5건 중 4건이 completed라
완료율 80%지만, 완료 4건 가운데 2건은 도구 실행 서술만 남겼고 1건은 `[thinking]`
누출과 프롬프트 반복이었다. 2026-07-23 21:46에 재현 가능한 기준선 원시 증거가
생성된 뒤에도 16:03 대표 산출물은 일반론을 반복한 옛 응답을 계속 가리켰다.

## Ground-truth evidence

- DB task: `task_Hg8EAhPiofUYUoMn`, `task_hdBl_7u7ln4fzhn0`,
  `task_e-_rSc9NAVSHcEc9`, `task_GgQ8CwfGz1FFiE3i`,
  `task_Gsr7Rm5UgWq47f4u`
- 실패: `orphaned: server restart (poison — requeued 2x)`
- 원시 기준선:
  `docs/technology-transfer/scrapling-baseline-2026-07-23/evidence-final/`
- 검증 결과: command 16/16 exit 0, Python 11/11, Vitest 48/48,
  typecheck 5/5, route 5,000요청 중 unexpected 0, snapshot drift 0
- 공식 릴리스: Scrapling v0.4.11,
  `aba2b3a57f3009cb6607dba58bb51863ca48d00d`
- 별도 검토 commit: `07a548362ff904a2837f503ed9d9f6b9dcef0195`

## Root cause

1. 생성된 원시 증거를 대표 산출물로 승격하는 연결이 없었다.
2. DB `completed`와 의미적으로 완결된 benchmark 결과를 같은 것으로 취급했다.
3. 낮은 품질의 반려 원문은 장기 기억에 축적됐지만, 검증된 evidence 위치와
   재사용 규칙은 Mem0/knowledge base에 증류되지 않았다.
4. 서버 재시작 orphan 실패와 응답 품질 실패가 한 completion 수치에 섞였다.

## Fix action

- 대표 산출물을 최신 원시 증거와 task 감사 표로 교체한다.
- 다음 규칙을 Mem0와 `knowledge_base`에 저장한다.
  - benchmark 완료 주장은 raw path, command, exit, sample 수, 통계 방식을 포함한다.
  - `completed` 상태만으로 성공을 주장하지 않는다.
  - 도구 함수 설명, “실행 중” 서술, `[thinking]` 누출은 증거로 승격하지 않는다.
  - 공식 release provenance SHA와 별도 검토 SHA를 구분한다.
  - security advisory 0건을 취약점 0건으로 해석하지 않는다.
- 보고 응답 첫 줄은 `done:` 또는 `status:` 프로토콜로 시작한다.

## Safety and rollback

- 팀을 삭제·비활성화하지 않고 lifecycle 상태를 변경하지 않는다.
- 파일 rollback은 이 노트와 교정된 일일 산출물만 되돌린다.
- DB rollback은 다음 정확한 ID만 삭제한다.
  - improvement note:
    `team-tech-port-04-baseline-cycle1-20260723`
  - knowledge base:
    `kb-team-tech-port-04-baseline-cycle1-20260723`
  - Mem0: `mem0-1784812541836-kia31s`

## Verification receipt

- NCO build: `tsc`, exit 0
- focused TypeScript: 4 files, 58/58 tests passed
- Scrapling adapter Python: 11/11 tests passed
- benchmark snapshot: before/after identical
- response quality: representative report pass, heuristics 0
- SQLite: `quick_check=ok`, foreign-key violations 0
- memory retrieval: Mem0 BM25 and knowledge-base lexical IDs matched

## Remaining gaps

- 외부 Obsidian 원본 vault 동기화는 미확인이다.
- Mem0와 knowledge base는 BM25/lexical 조회를 검증했지만 로컬 embedding
  서비스가 응답하지 않아 semantic embedding은 미생성이다.
- 실제 허가 사이트 E2E, command별 peak RSS, 배포 build 크기는 미측정이다.
- 다음 독립 표본 전에는 score 개선을 주장하지 않는다.

---
created_at: 2026-07-29T03:15:27+09:00
team_id: team_content-quality
team_slug: content-quality
cycle: 5
artifact_type: mem0-registration-candidates
evidence_tier: T1
tags:
  - mem0
  - candidate
  - content-quality
  - deduplication
---

# content-quality Cycle 5 — Mem0 장기기억 등록 후보

이 파일은 등록 후보 목록이다. Mem0 DB/API에는 쓰지 않았다.
시점 의존 metric과 기존 기억의 중복 저장을 피한다.

## 후보 1 — post-fix 효과 판정에는 post-fix 표본이 필요

- candidate key:
  `team-content-quality-post-fix-efficacy-requires-new-sample-v1`
- decision: `register_candidate`
- namespace: `team:team_content-quality`
- importance proposal: `1.0`
- proposed content:

  > Rolling 팀 점수가 fix 뒤에도 같다는 사실만으로 fix 실패를 판정하지 않는다.
  > fix effective timestamp 뒤에 생성된 동일 경로 task가 최소 1건 있어야 하며,
  > source task ID·원문 response·verifier·status를 함께 확인한다. post-fix 표본이
  > 0건이면 효과는 unverified로 둔다. 과거 failed task나 score snapshot을 성공으로
  > 다시 쓰지 않는다.

- T1 sources:
  - `db/nco.db`
    `tasks.id='task_JjX-85_K_1H7WuEC'`
  - `db/nco.db`
    `tasks.id='task_VZ3TWJjdlYpZ73Ab'`
  - `db/nco.db`
    `team_lifecycle_events.id='tle_V_ZP0mjFb_5bpwPd'`
  - commit
    `7305bd37fc0b34b66c3ac1161a3d1d15fbe8dbcb`
  - fix 이후 content-quality implementation/verification task count: `0`
- revalidation:
  `tasks.created_at > '2026-07-28 12:59:44'`인 동일 팀 protocol task를 조회해
  원문·verifier·status를 대조한다.
- expiry: 없음. metric 값이 아니라 검증 규칙만 저장한다.

## 후보 2 — quoted protocol normalization

- candidate key:
  `team-content-quality-quoted-protocol-normalization-v1`
- decision: `skip_duplicate`
- duplicate of:
  `mem0_entries.id='mem0-1785242779311-najnyw'`
- 이유: 전체 응답이 유효한 JSON string 하나일 때만 decode하고 malformed/non-protocol
  JSON은 거부한다는 규칙과 source task가 이미 저장돼 있다.
- 조치: 신규 삽입하지 않는다.

## 후보 3 — 이벤트 기반 검수기의 입력계약

- candidate key:
  `team-content-quality-event-input-contract-v1`
- decision: `skip_duplicate`
- duplicate of:
  `mem0_memories.id='mem0-1785249560319-20adab'`
- 이유: 원문 미주입 시 점수를 만들지 않고 보류하며 task status와 콘텐츠 verdict를
  혼동하지 않는 규칙이 이미 포함돼 있다.
- 보완 위치: 장기기억 중복 삽입 대신
  `db/migrations/097_content_quality_dedicated_runner.sql`과
  `scripts/team-runner.sh:69`를 실행 계약으로 참조한다.
- 조치: 신규 삽입하지 않는다.

## 후보 4 — 최신 score/completion 값

- candidate key:
  `team-content-quality-score-83.8-completion-87.5-20260728`
- decision: `do_not_store`
- 이유: `score=83.8`, `completion=87.5`, `n=8`, `maxN=61`은 rolling 48시간
  스냅샷이라 장기 규칙이 아니다.
- canonical evidence:
  `team_lifecycle_events.id='tle_V_ZP0mjFb_5bpwPd'`
- 조치: Obsidian 감사 노트에만 보존한다.

## 후보 5 — 근거 없는 `80% 향상` 주장

- candidate key:
  `team-content-quality-ungrounded-80-percent-claim`
- decision: `do_not_store_as_fact`
- source:
  `tasks.id='task_qrxIUr3BQAgn8Ojy'`
- 이유: verifier/evidence가 없으므로 수치를 사실이나 목표치로 저장할 수 없다.
- reusable rule:
  정량 향상률은 baseline·측정식·comparison window·검증 결과가 모두 있을 때만
  장기기억 후보가 된다.
- 조치: `80%` 자체는 등록하지 않는다. 위 일반 규칙은 후보 1과 별도 검증 정책으로
  추후 통합 검토한다.

## 등록 결과

- 실제 Mem0 insert/update: `0`
- 신규 등록 추천: 후보 1 한 건
- 중복으로 제외: 후보 2, 후보 3
- 사실로 저장 금지: 후보 4, 후보 5
- NCO HTTP/Mem0 API 검증: **unverified** — `localhost:6200` 연결 거부

## 재검증 쿼리

```bash
sqlite3 -readonly -json db/nco.db "
SELECT id,agent_id,content,metadata,created_at
FROM mem0_memories
WHERE id='mem0-1785249560319-20adab';
SELECT id,agent_id,content,embedded,semantic,importance,created_at
FROM mem0_entries
WHERE id='mem0-1785242779311-najnyw';"
```

## 롤백

이 후보 목록 파일을 삭제하면 문서 변경만 원상복구된다. Mem0 DB/API에는 쓰지
않았으므로 memory rollback은 없다.

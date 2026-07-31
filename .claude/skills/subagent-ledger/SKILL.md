---
name: subagent-ledger
description: 서브에이전트/프로바이더 위임의 성공·실패를 기록하고 조회할 때 사용한다. 위임 결과를 보고하기 전, 성공률·실패 분류를 확인해야 할 때, "이 방법이 전에 통했나?"를 판단해야 할 때, 또는 위임 후 검증 영수증을 작성할 때 읽어라. 원장은 data/subagent-ledger/runs.jsonl 이며 조회는 scripts/codex-subagent.sh stats 다.
---

# 서브에이전트 성공/실패 원장

위임 결과를 **기억에 의존하지 않고 파일로** 남긴다. 목적은 두 가지:
1. "완료" 주장의 T1 근거 확보 (자기 보고 ≠ 검증)
2. 실패한 방법을 두 번 던지지 않게 만드는 입력 데이터

## 저장 위치

| 원장 | 경로 | 무엇이 들어가나 |
|---|---|---|
| 실행 원장 | `data/subagent-ledger/runs.jsonl` | 모든 위임 1건 = 1줄. 성공·실패·조기차단 전부 |
| 교훈 원장 | `~/.claude/.loop-lessons/lessons.jsonl` | 실패 분류별 교훈. UserPromptSubmit 훅이 **다음 턴에 자동 주입** |
| 시스템 원장 | `db/nco.db` — `tasks`, `learning_events`, `dead_letter_tasks`, `subagent_runs` | NCO 백엔드가 직접 쓰는 지상 진실 |

## 스키마 (`runs.jsonl` 1줄)

```json
{"ts":"2026-07-30T07:32:42Z","role":"codex-bugfix","ai":"codex","fingerprint":"a1b2c3d4e5f60718",
 "taskId":"task_...","outcome":"completed|failed|poll_timeout",
 "failure_class":"F1_CB_CASCADE|...|null","error":"...","response_len":1234}
```

- `fingerprint` = `sha256(role + "\n" + prompt)[:16]` — **같은 지문이 2회 실패하면 디스패처가 3번째를 차단**한다(exit 5).
- `failure_class` = [[subagent-failure-modes]] 의 F## 코드.
- `outcome: "completed"` 는 "위임이 끝났다"는 뜻이지 "동작한다"는 뜻이 **아니다**. 동작 주장은 별도 검증(tsc / curl / 파일 확인)이 필요하다.

## 명령

```bash
scripts/codex-subagent.sh stats            # 성공률 + 실패 분류 + role 별 롤업
scripts/codex-subagent.sh stats 30         # 기간 지정

# 원장 직접 조회
tail -5 data/subagent-ledger/runs.jsonl | python3 -m json.tool --json-lines 2>/dev/null \
  || tail -5 data/subagent-ledger/runs.jsonl

# 특정 분류만
grep -c 'F1_CB_CASCADE' data/subagent-ledger/runs.jsonl

# 시스템 원장 대조 (지상 진실)
sqlite3 -header -column db/nco.db "SELECT id,assigned_to,status,substr(error,1,80) FROM tasks
  WHERE created_at >= datetime('now','-1 day') AND status<>'completed' ORDER BY created_at DESC LIMIT 20;"
```

## 기록 규칙

1. **`scripts/codex-subagent.sh run` 을 경유하면 기록은 자동**이다. 직접 `curl /api/task` 로 우회하면 원장에 구멍이 생긴다 — 우회하지 않는다.
2. 조기 차단(`NCO_OFFLINE`/`GATE_BLOCKED`/`REPEAT_BLOCKED`)도 **실패로 기록된다**. "던지지 못한 것"도 실패 이력이다.
3. 디스패처를 쓰지 않은 위임(MCP `nco_task`, `/nco-team` 등)을 기록하려면 수동으로:
   ```bash
   ~/.claude/hooks/loop-lesson.sh add "subagent-<ai>-<F##>" "<무엇이 왜 실패했고 다음엔 무엇을 다르게>"
   ```
4. **분류 불가(`UNCLASSIFIED`)** 가 남으면 새 실패 요인이다 → `scripts/codex-subagent.sh` 의 `RULES`/`ADVICE` 와 [[subagent-failure-modes]] 에 항목을 추가한다.

## 보고 시 사용법 (검증 영수증에 붙일 것)

```markdown
- [검증방법] `scripts/codex-subagent.sh stats` → role=codex-bugfix 3/3 · `tail -1 data/subagent-ledger/runs.jsonl` → outcome=completed
- [등급] T1 (원장 파일 내용 직접 확인)
- [미검증항목] 산출물 동작 검증 (원장은 위임 완료만 증명 — tsc/테스트는 별도)
```

**금지**: 원장을 손으로 편집해 성공률을 올리는 것. 실패 줄을 지우는 것. 원장이 신뢰를 잃으면 실패 반복 차단 기능(지문 2회 룰)이 함께 죽는다.

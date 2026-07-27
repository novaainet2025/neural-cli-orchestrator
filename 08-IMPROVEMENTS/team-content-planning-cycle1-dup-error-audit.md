# team_content-planning cycle1 — 중복에러방지팀 감사

작성: 2026-07-27 (KST 2026-07-28) · 대상: `team_content-planning` (콘텐츠 기획팀)
HR 입력: score=83.6 / completion=87.5% / sample=48h·8
근거: `db/nco.db` 직접 조회 · `dist/` 실행 · `crontab -l` · 외부 저장소 소스 (전부 T1)

---

## 1. 48h 실패 태스크 ↔ 기존 CB/Gate 규칙 교차검증

48h 창(2026-07-25 18:34 ~ 2026-07-27 18:34 UTC) 원시 9행 = completed 7 / failed 2.

| task id | 시각(UTC) | agent | error | 기존 규칙 등록 여부 |
|---|---|---|---|---|
| `task_gudqikH8LkuQ6-Cy` | 07-26 00:03:33 | opencode | `Circuit breaker open for agent opencode (generic)` | **기등록(중복)** — `INFRA_EXCLUSION`의 `Circuit breaker open%` + `work-report-scheduler.ts:1376` breaker 가드 + 07-26 redispatch LIMIT 수정 |
| `task_content_generation` | 07-27 17:10:06 | cursor-agent | `cursor-agent: CLI failed exit=unknown — Command failed with ENOENT` | **신규 패턴** — 단 프로바이더 신뢰도 문제가 아님(§3) |

### 기등록 패턴이 실제로 동작 중임 (T1)
`Circuit breaker open%` error를 가진 tasks 행 수 / 일 (전 팀):

```
2026-07-24  331
2026-07-25 1812   ← 폭주 (이 팀 82행 포함: '[업무보고 작성]' 동일 프롬프트 70회 + 10회 재발행)
2026-07-26   73   ← 가드 배포
2026-07-27    0
2026-07-28    0
```

이 팀의 07-25 버스트는 프롬프트 앞 200자 기준 82행 중 고유 프롬프트 **3종** — 즉 동일 업무보고 1건이
매 틱 재발행되며 즉시 실패 행을 양산한 전형적 중복 증폭이다. 해당 패턴은 이미
`work-report-scheduler.ts`에 실측 주석과 함께 가드가 들어가 있고, 위 일별 추이가 그 효력의 실증이다.
**중복 규칙 추가 불필요.**

---

## 2. `config/ai-providers.json` / CB 임계값 — 변경하지 않음 (diff 0)

변경을 정당화할 실측 근거가 없어 의도적으로 0 diff로 둔다. 수치 없이 임계값을 바꾸는 것은 날조다.

| 확인 항목 | 실측값 | 판단 |
|---|---|---|
| ENOENT error 빈도 (14일, 전 팀) | **1건** (`cursor-agent`, 07-27) | 재발성 없음 → retry/임계값 근거 없음 |
| `circuit_states.cursor-agent` | `closed`, failure_count=0 | 회로가 열린 적 없음 → 임계값 무관 |
| 동시간대 cursor-agent 형제 태스크 | 17:10:25 / 17:11:39 / 17:12:03 / 17:17:03 **전부 completed** | 프로바이더 가용성 정상 |
| 48h 실패 중 rate-limit/quota 사유 | 0건 | `rateLimitRpm` 조정 근거 없음 |

ENOENT의 실제 원인은 프로바이더 신뢰도가 아니라 **NCO가 실행해서는 안 될 행을 실행한 것**이다(§3).
`rateLimitRpm`·CB 임계값 어느 쪽을 바꿔도 이 실패는 막지 못한다.

---

## 3. 신규 패턴: 외부 주입 행의 orphan 채택 (근본원인)

### 메커니즘 (T1)
`crontab -l` → `0 */6 * * * cd /Users/nova-ai/project/nova-sns && python3 automation/trend-collector.py`

`/Users/nova-ai/project/nova-sns/automation/trend-collector.py:400` `register_nco_task()`:

```python
conn = sqlite3.connect("/Users/nova-ai/project/nco/db/nco.db")
cursor.execute("""INSERT OR REPLACE INTO tasks (id, mode, prompt, assigned_to, status, team_id, created_at, updated_at)
                  VALUES (?, 'task', ?, ?, ?, ?, datetime('now'), datetime('now'))""", ...)
```

즉 **게이트웨이·이벤트버스·evidence gate·quality gate·circuit breaker를 전부 우회**해 raw sqlite3로
`tasks`에 직접 쓴다. 호출부(`content-gen.py:803/819/827`, `trend-collector.py:423`)는 고정 ID
`task_trend_collector` / `task_content_generation` / `task_quality_check`를 쓰고, prompt에는 지시문이 아니라
**상태 문구**("누락된 SEO 키워드 분석 및 최적화 중")를 넣는다.

파이썬이 완료 UPDATE 전에 죽거나 그 사이 NCO가 재시작되면 행은 `running`으로 남고, 부팅 orphan 복구가
이를 정상 in-flight 태스크로 오인해 **실제 CLI 에이전트에 재배정**한다.

| 행 | orphan_requeue_count | 주입 시 assigned_to | 현재 assigned_to | 귀결 |
|---|---|---|---|---|
| `task_content_generation` | 1 | mlx | cursor-agent | ENOENT 실패 → **team_content-planning 계상** |
| `task_quality_check` | 2 | ollama | claude-code | team_quality-audit에서 동일 경로 |
| `task_trend_collector` | 0 | mlx | mlx | 아직 미채택(다음 부팅에 채택 예정) |

`agent_actions`에 이 3행의 `task:created` / `task:completed` 이벤트가 **0건**이다(14일, 팀 귀속 6,052행 중
이벤트 없는 행은 정확히 이 3건). 같은 시각(07-27 15:00:00~15:01:00, 17:09~17:23) 다른 태스크들의
이벤트는 정상 기록돼 있어 로깅 누락이 아님이 확인된다.

### 게이트 갱신 (구현)

`src/core/orphan-recovery-policy.ts` — `decideOrphanRecovery`에 `externallyInjected` 입력과
`dead_letter:external_injection` 분기 추가 + 판별식 `isExternallyInjectedOrphan()` + 토글
`isExternalInjectionGuardEnabled()`.

판별식(주입 직후 원본 상태만 선택):
`team_id` 있음 ∧ `metadata_json` 빈값 ∧ `system_prompt` 빈값 ∧ `spawned_by_cli` 빈값 ∧ `orphan_requeue_count = 0`

`src/index.ts` — orphan SELECT에 `team_id, spawned_by_cli` 추가, 가드 통과 시 dead-letter 사유
`orphaned: external injection (not created by NCO — never dispatched)`.
접두사 `orphaned:` 이므로 `team-scorer`의 `INFRA_EXCLUSION`이 이미 커버 → 팀 완료율에 계상되지 않는다.

### 블라스트 반경 (dist 실행, 실 DB, read-only)
- 현재 복구 대상 in-flight 4행 → **4행 모두 기존과 동일하게 requeue** (동작 변화 0)
- 14일 팀 귀속 6,052행에 판별식 적용 → **적중 1건**(`task_trend_collector`, 확인된 주입 행). 오탐 0.
- 이미 재큐잉된 행(`count>0`)은 조건에서 제외 → 소급 변경 없음

---

## 4. False report 식별 목록

"LLM이 실패에도 성공 보고" 사례를 tasks 로그 ↔ 실제 실행 증거로 대조한 결과:

### 4-1. LLM 발 허위보고: **0건**
- 48h 창에 `status='completed'` 이면서 `error`가 비어있지 않은 행: **0건** (전 팀)
- 48h 창에 completed + 산출물 0B 행: **1건** — 아래 4-2 (LLM이 아님)
- 이 팀의 completed 6건(`agy` 5 / `claude-code` 1)은 모두 응답 본문 952~2,196B 실재 + `task:completed` 이벤트 존재

### 4-2. 비-LLM 발 허위 성공(phantom completion): **2건**

| id | 팀 | 주장 | 실제 증거 | 판정 |
|---|---|---|---|---|
| `task_trend_collector` | team_content-planning | `completed` @07-27 15:00:09 | `task:created`/`task:completed` 이벤트 0건 · response 0B · result_json NULL · evidence_json NULL · progress 0.0 · 에이전트 미기동 | **허위 성공** — `trend-collector.py:429`가 파이썬 `try/except` 통과만으로 상태를 씀. 에이전트 exit code와 무관 |
| `task_quality_check` | team_quality-audit | `completed` @07-27 01:18:14 | 동일 서명(이벤트 0건, provenance 컬럼 전무). response 566B는 orphan 채택 후 claude-code가 채운 것 | **허위 성공** — `content-gen.py:806` 동일 메커니즘 |

`register_nco_task(..., 'completed')`는 **어떤 exit code도 읽지 않는다**. 성공 판정 근거는 파이썬 함수가
예외 없이 반환했다는 사실뿐이며, `assigned_to='mlx'`는 실행 주체가 아니라 라벨이다.
이 행은 팀 완료율 분자를 부풀린다.

### 4-3. 오귀속 실패(허위보고 아님): 1건
`task_content_generation` — 실패는 실제(ENOENT)지만, 원인은 팀·프로바이더가 아니라 §3의 주입 행 채택이다.

---

## 5. 미해결 / 범위 밖

- **주입원 자체는 수정하지 않음.** `/Users/nova-ai/project/nova-sns/`는 별도 저장소로 이번 작업 범위(NCO) 밖이다.
  근본 차단은 그쪽에서 raw sqlite3 쓰기를 NCO API(`POST /api/tasks`) 호출로 바꾸는 것이며, 별도 승인 필요.
- 이번 게이트는 **주입 행이 실행되는 것**과 **그 실패가 팀에 계상되는 것**만 막는다.
  이미 `completed`로 쓰인 phantom 행(4-2)이 분자를 부풀리는 문제는 그대로 남아 있다 —
  scorer 분자 측 처리는 이번 범위에서 손대지 않았다(별도 판단 필요).
- 런타임 NCO 프로세스는 재시작 전이라 새 dist 미로드. 게이트는 **부팅 경로**에서만 도는 코드라
  다음 재시작 시 발효된다.

## 6. 롤백

- 런타임 즉시: `NCO_ORPHAN_EXTERNAL_INJECTION_GUARD=off` (재빌드 불필요, 실 DB dry-run으로 실증)
- 코드: `git apply --reverse 08-IMPROVEMENTS/team-content-planning-cycle1-orphan-injection-gate.patch`
  (`--check --reverse` exit 0)

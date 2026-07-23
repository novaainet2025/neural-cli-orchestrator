# P11 — 단일 팀 위임 transient 재시도 (team-aware, 1회)  [Tier2 · 98% 마무리 · 리스크 낮음 · 독립롤백 O]

> claude-2 설계 (claude-3 요청). 제약 준수: `resolveExecutorChain`+`providerModelDispatchable` 재사용(중복금지),
> transient만 감지(정상완료 오탐금지), 1회 재시도. **구현·빌드·재시작은 claude-3(락 존중).**

## 대상 레이어 결정 (판단 근거)

**결론: `src/core/task-queue.ts` 의 `enqueue()` 루프.** (nco-company.md 커맨드도, gateway `/api/task` 라우트도 아님)

| 후보 | 판정 |
|---|---|
| `nco-company.md` 단일위임 경로 | ❌ 그 커맨드 한 caller만 커버. `/api/task`를 직접 부르는 다른 경로(monitor, mesh, 다른 세션)는 미커버. |
| gateway `/api/task` 라우트(gateway.ts:1303) | ❌ 202 즉시반환(fire-and-forget) — **결과(빈응답/timeout)를 알 수 없어** 동기 재시도 불가. |
| **`task-queue.ts` `enqueue()` (line 681~736)** | ✅ **모든** 태스크 실행의 단일 결과처리 지점. 이미 rate-limit 재시도·`persistTaskReassignment`·idle-timeout 재시도 인프라 보유. transient는 여기서만 관측·재시도 가능. **DRY**. |

**현 갭(실측 근거):** enqueue 루프에서
- line 712 `if (result.success) return result;`
- line 713-717: `timeout(idle)`는 **같은 에이전트** 1회 재시도(다른 후보 아님 → 진짜 stuck이면 또 실패)
- line 721 `if (!isRateLimitError(errMsg))`: silent-failure(빈응답)는 `tryTierEscalation`(tier 정책, **team 비인지**)로만 감 → 팀의 의도된 대체 실행자(lead/member 체인) 미사용, `providerModelDispatchable` 미검증
→ 배포후 잔여실패(cursor-agent 빈응답·opencode idle-timeout·claude-code 빈응답)가 team-aware failover를 못 받음.

---

## 신규 헬퍼 3개 (task-queue.ts 내부, `classifyResult`(line177) 아래 삽입)

```ts
// ── P11: 단일 팀 위임 transient 재시도 지원 ──────────────────────────────
// 정상완료·사용자취소·rate-limit은 제외. transient(프로바이더 무응답/idle/abort)만 true.
export function isTransientFailure(result: TaskExecutionResult): boolean {
  if (result.success) return false;                 // 정상완료는 절대 재시도 안 함(오탐 방지)
  if (result.status === 'cancelled') return false;  // 사용자 취소 재시도 금지
  const err = result.error ?? '';
  return err.startsWith('silent-failure:')            // classifyResult: 빈출력/무응답/limit메시지
      || err === 'timeout(idle)'                      // idle 타임아웃(활동 없음)
      || /aborting operation|aborted by (the )?provider/i.test(err); // 프로바이더측 abort
  // 주의: isRateLimitError(err)는 여기 포함 안 함 — rate-limit은 기존 backoff 루프가 처리(중복금지).
}

// team_id(태스크 DB 컬럼)로 TeamRow(lead+members) 로드. company-orchestrator.loadTeams와 동일 스키마.
// (nco-company.md 단일위임은 task 생성 후 UPDATE tasks SET team_id 하므로 metadata가 아닌 DB에서 읽는다.)
function loadTeamRowById(teamId: string): TeamRow | null {
  const db = getDb();
  const t = db.prepare(
    `SELECT id, name, slug, lead, charter, description FROM teams WHERE id=? AND is_active=1`
  ).get(teamId) as { id: string; name: string; slug: string; lead: string | null; charter: string | null; description: string | null } | undefined;
  if (!t) return null;
  const members = (db.prepare(
    `SELECT member_ref FROM team_members WHERE team_id=? ORDER BY created_at ASC, id ASC`
  ).all(teamId) as Array<{ member_ref: string }>).map((r) => r.member_ref);
  return { ...t, members };
}

// 팀 체인에서 "아직 안 시도 + 모델검증 통과" 첫 실행자. 없으면 null(→ 기존 escalation 폴백).
// resolveExecutorChain + providerModelDispatchable 재사용(중복금지).
async function nextTeamExecutor(taskId: string, knownAgents: Set<string>, attempted: string[]): Promise<string | null> {
  const db = getDb();
  const row = db.prepare(`SELECT team_id FROM tasks WHERE id=?`).get(taskId) as { team_id: string | null } | undefined;
  const teamId = row?.team_id ?? null;
  if (!teamId) return null;                          // 팀 태스크 아님 → P11 스킵
  const team = loadTeamRowById(teamId);
  if (!team) return null;
  const avail: AvailabilityFn = (id) => {
    if (!knownAgents.has(id)) return false;
    try { return circuitBreakerRegistry.getAvailability(id).available; } catch { return true; }
  };
  const chain = resolveExecutorChain(team, knownAgents, 'ollama', avail);
  for (const cand of chain) {
    if (attempted.includes(cand)) continue;          // 이미 시도한(=실패한) 실행자 제외
    if (await providerModelDispatchable(cand)) return cand; // 모델 존재 검증 통과자만
  }
  return null;
}
```

### import 추가 (task-queue.ts 상단 import 블록)
```ts
import { resolveExecutorChain, providerModelDispatchable, type TeamRow, type AvailabilityFn } from './company-orchestrator.js';
```
- 순환참조 없음: company-orchestrator 는 agent-manager/database/circuit-breaker만 import(task-queue import 안 함) — 확인함.
- `circuitBreakerRegistry` 는 task-queue 에 이미 import 되어 있음(재사용). 없으면 `import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';` 추가.

---

## enqueue() 루프 수정 (task-queue.ts line 681~731)

**앵커 1** — 재시도 플래그 선언. line 681 `let stallRetried = false;` **아래**에 추가:
```ts
    let stallRetried = false;
    let teamRetried = false;   // P11: 팀 transient failover는 태스크당 1회만
```

**앵커 2** — `for` 루프 내부, line 712 `if (result.success) return result;` **바로 아래**에 team-aware 블록 삽입(기존 idle-timeout/escalation 블록보다 **먼저**):
```ts
      if (result.success) return result;

      // ── P11: 팀 위임 transient 실패 → 팀 실행자 체인 다음 후보로 1회 재시도(team-aware) ──
      // company-orchestrator 파이프라인의 stage-failover(P5)를 단일 팀 위임(/api/task 직행)에도 부여.
      // 정상완료·사용자취소·rate-limit은 isTransientFailure에서 이미 배제 → 오탐 없음.
      if (!teamRetried && isTransientFailure(result)) {
        const known = new Set(this.agents.keys());
        const next = await nextTeamExecutor(task.taskId, known, attemptedAgents);
        if (next && next !== currentAgentId) {
          teamRetried = true;
          const previousAgentId = currentAgentId;
          currentAgentId = next;
          attemptedAgents = appendAttemptedAgent(attemptedAgents, next);
          currentMetadata = persistTaskReassignment(task.taskId, previousAgentId, next, { attemptedAgents });
          log.warn(
            { taskId: task.taskId, from: previousAgentId, to: next, reason: result.error },
            'P11 team transient failover — retrying once with next chain executor',
          );
          continue; // 다음 루프 반복에서 next 실행자로 runEnqueue 재실행
        }
      }
```

**설명**: `continue` 후 다음 반복은 line 710 `runEnqueue({ ...task, agentId: currentAgentId, ... })` 를 `next` 실행자로 재실행. `teamRetried`로 1회 상한. team 후보가 없으면(`next==null`) 블록을 그냥 통과 → 기존 idle-timeout(713)·escalation(724) 경로 유지(회귀 없음).

**주의(중복 방지)**: 기존 line 713 `timeout(idle)` 블록은 **그대로 둔다**. P11이 먼저 team-aware 재시도를 시도하고(팀 태스크만), 팀 후보가 없거나 비팀 태스크면 기존 same-agent idle 재시도가 폴백으로 작동. 순서상 P11이 우선이므로 팀 태스크의 idle-timeout도 다른 후보로 재시도됨(개선). `teamRetried`가 true면 P11 재진입 안 함 → 무한루프 없음.

---

## 리스크 / 롤백 / 회귀

- **리스크 낮음**: 추가 경로는 `isTransientFailure && 팀태스크 && 미재시도 && 후보존재`일 때만. 그 외 전부 기존 동작 그대로. `teamRetried` 1회 상한 → 재시도 폭주 없음. `providerModelDispatchable`이 broken-model 후보 배제 → ProviderModelNotFound 재발 방지.
- **정상완료 오탐 0**: `isTransientFailure`가 `result.success===true`를 최상단에서 배제. limit/credential 메시지는 classifyResult가 이미 silent-failure로 표준화(재사용).
- **독립 롤백**: 앵커1(1줄)·앵커2(블록)·헬퍼3개·import 1줄 제거하면 원복. 다른 패치(P1~P10) 무영향.
- **성능**: `nextTeamExecutor`는 실패 시에만 호출(핫패스 아님). `providerModelDispatchable`은 P4의 60s 캐시 사용.

## 효과 증명 (T1)

1. `npx tsc --noEmit` → 0.
2. `npx vitest run src/core/task-queue.test.ts src/core/company-orchestrator.test.ts` → 기존 전부 통과(추가 함수는 additive).
3. **신규 유닛테스트** (task-queue.test.ts): `isTransientFailure` 진리표 —
   `{success:true}`→false, `{success:false,status:'cancelled'}`→false,
   `{success:false,error:'silent-failure: empty output'}`→true, `{success:false,error:'timeout(idle)'}`→true,
   `{success:false,error:'Aborting operation...'}`→true, `{success:false,error:'rate limit exceeded'}`→false(기존 경로).
4. **라이브 실측**: team lead=cursor-agent 팀에 `/nco-company <team> <task>` 위임 → cursor-agent가 빈응답 반환하도록 유도(또는 자연 발생) → `GET /api/tasks?id=`에서 `metadata.reassignedFrom=cursor-agent`, `attemptedAgents=[cursor-agent, <next>]`, 최종 status=completed 확인. 로그에 `P11 team transient failover` 1건.
5. **성공률 재측정**: 배포 전후 최근 30분 팀작업 성공률 비교 — 잔여 transient(빈응답/idle/abort)가 재시도로 흡수되어 94~95% → 98%+ 목표.

---

## 통합 순서 제안
P11은 P3(resolveExecutorChain)·P4(providerModelDispatchable) 의존 → **P3·P4 배포 후** 적용(이미 배포됨). Tier2 이므로 P5/P6와 동급 지렛대(단일위임 경로 커버). 적용 후 위 증명 4·5로 98% 확인.

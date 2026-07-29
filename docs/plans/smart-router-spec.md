# NCO company-orchestrator 98% 개선 설계 스펙 (claude-2 → claude-3)
# 울트라코드 워크플로우 wf_d3e31d50 산출 (7에이전트·3관점·적대검증·합성)
# 실제 파일 대조 검증: tsc 0, company-orchestrator.test.ts 31/31, ProviderConfig 필드 실존 확인

Everything verified against the real file. Baseline: `tsc` 0 errors, `company-orchestrator.test.ts` 31/31 pass. `rate_limit_state(agent_id PK, is_limited)` exists (007), `ProviderConfig` has `type:'cli'|'api'|'local'` / `model` / `endpoint?` / `apiConfig?.primary.{baseUrl,model}`, `smartRouter.inferTaskType`/`analyzeComplexity` are public, `classifyTier`/`Tier`/`TaskType` exported, `noUnusedLocals:false`, file is untracked (rollback = revert edits). Here is the synthesized spec.

---

# 단일 구현 스펙 — company-orchestrator.ts (3-lens 합성)

## 충돌·중복 해소 결정 (합성 규칙)

| 원설계 중복/상충 | 판정 |
|---|---|
| R2 `resolveExecutorChain` vs P2-parallel `pickAlternateExecutor` | **`pickAlternateExecutor` 폐기**. 병렬 재시도는 `resolveExecutorChain`에서 "이미 시도한 executor 제외 후 첫 모델검증 통과자"를 취한다(단일 체인 소스). |
| R7(reliability parallel) vs P1/P2(parallel-min) | **P1/P2로 통합**(더 풍부: `'partial'`+`summary`+substantive 게이트+재시도). R7의 단순 completed/failed는 흡수. |
| R6 `attempt` vs P1 `retryCount` | **둘 다 채택**(직교 진단: 순차=attempt, 병렬=retryCount). |
| cap-2/3 capability 재선정 vs R2/R4 role 체인 | **공존·정렬**: cap 재선정은 `stage.executor`를 dispatch 전에 역량-최적으로 세팅. `runStageWithFailover`/병렬은 `stage.executor`를 체인 head로 **seed**해 attempt#1로 존중, 이후 role/fallback 순으로 failover. chain[0] 일관성 유지. |
| 검증 verdict 공통 지적(3개 모두): 병렬이 substantive 게이트 미적용 → 빈응답 마스킹 | **병렬 `collectStage`에 `isSubstantiveOutput` 적용**(P6에 반영). |
| reliability verdict P2: 최종 stage substantive hard-fail = 완성률 순손실 | **P5에 최종 stage 게이트 예외** 반영(하류 없음 → 캐스케이드 이득 0). |

**우선순위 원칙**: 실패주원인 직접감소 × 낮은 리스크. Tier1(P1–P4)=저리스크 순수/게이트 기반(독립 적용 가능). Tier2(P5–P6)=98% 최대 지렛대(all-or-nothing·parallel fire-and-forget 제거, 행위변경). Tier3(P7–P8)=역량 재선정(verdict "표면적" 평가 → 후순위). Tier4(P9–P10)=테스트·위생.

기존 테스트 보존: import 9심볼(`rankTeam/orderTeams/resolveExecutor/resolveDecomposer/resolveDecomposers/parseDecomposition/buildDecompositionPrompt/templateSubtask/isSubstantiveOutput`)·`TeamRow`·`resolveExecutor`(2·4-arg)·`resolveDecomposers`(3-arg)·`MIN_SUBSTANTIVE_CHARS=200` **전부 불변**. 신규는 전부 additive export.

---

## P1 — 주간/일일 리밋 executor 즉시 스킵 (R1)  [Tier1 · 리스크 낮음 · 독립롤백 O]

**파일**: `src/core/company-orchestrator.ts` · **앵커**: 라인 22–28 `function liveAvailability` 전체 교체.

**근거**: `liveAvailability`가 서킷만 보고 `rate_limit_state.is_limited=1`(주간리밋 27 실패주원)을 안 봐 리밋 provider가 선택단계를 새어나감. smart-router.isAvailable과 동일 게이트를 호출당 1회 배치조회+lazy 캐시로 추가(핫패스 DB 왕복 없음). 시그니처·fallback 의미 불변 → P3~P8 및 기존 startCompanyRun/driveRun 호출부 무변경.

**최종 코드**:
```ts
function liveAvailability(known: Set<string>): AvailabilityFn {
  // rate_limit_state 스냅샷을 호출당 1회만 읽어 lazy 캐시(핫패스 DB 왕복 방지).
  let limited: Set<string> | null = null;
  const getLimited = (): Set<string> => {
    if (limited) return limited;
    limited = new Set<string>();
    try {
      const rows = getDb()
        .prepare(`SELECT agent_id FROM rate_limit_state WHERE is_limited=1`)
        .all() as Array<{ agent_id: string }>;
      for (const r of rows) limited.add(r.agent_id);
    } catch { /* 테이블 없음/오류 → 리밋 정보 없이 진행 */ }
    return limited;
  };
  return (id: string) => {
    if (!known.has(id)) return false;
    if (getLimited().has(id)) return false; // 주간/일일 리밋 즉시 스킵
    try { return circuitBreakerRegistry.getAvailability(id).available; }
    catch { return true; } // 판정 불가 시 보수적으로 시도 허용
  };
}
```
**독립 롤백**: 원 3줄 함수로 되돌리면 끝(다른 패치 무영향 — 게이트만 완화됨).
**효과 증명**: (T1) `npx tsc --noEmit`→0. `npx vitest run src/core/company-orchestrator.test.ts`→31/31(liveAvailability 미참조). 라이브: `sqlite3 <db> "INSERT OR REPLACE INTO rate_limit_state(agent_id,is_limited) VALUES('codex',1)"` 후 lead=codex 팀 run → `GET .../runs/<id>`에서 해당 stage.executor≠codex(대체) + executorNote 기록.

---

## P2 — 진단·상태 타입 확장 (R6 + P1-parallel)  [Tier1 · 리스크 없음 · 독립롤백 O]

**파일**: 동. **앵커 3곳**:
1. 라인 33–35 `RunStatus` 유니온 — `'partial'` 추가.
2. `RunStage` 인터페이스 라인 61 `outputChars?` 아래 — `attempt?`, `retryCount?` 추가.
3. `CompanyRun` 인터페이스 라인 78 `error?` 위 — `summary?` 추가.

**근거**: P5(attempt)·P6(retryCount·partial·summary)가 소비. optional 필드/유니온 확장이라 기존 stage 생성·직렬화·31테스트 무영향. teams 라우트는 run 객체를 그대로 JSON 반환 → 신규 필드 자동 노출.

**최종 코드**:
```ts
// (1) 라인 33–35 교체:
export type RunStatus =
  | 'pending' | 'decomposing' | 'planned' | 'dispatching' | 'running'
  | 'dispatched' | 'completed' | 'failed' | 'partial';

// (2) RunStage: outputChars 아래에 추가:
  outputChars?: number;    // 산출물 길이(빈 산출물 진단)
  attempt?: number;        // 순차 failover: 몇 번째 후보에서 처리됐는지
  retryCount?: number;     // 병렬 재시도 횟수(0=재시도 없음)

// (3) CompanyRun: stages 아래(error 위)에 추가:
  summary?: { total: number; succeeded: number; failed: number; retried: number };
```
**독립 롤백**: 세 조각 제거(단, P5·P6 적용 상태면 그들이 참조하므로 P6→P5→P2 역순 제거). P2 단독 적용 시 완전 무해.
**효과 증명**: `npx tsc --noEmit`→0. 31/31 유지.

---

## P3 — resolveExecutorChain 신규 export (R2)  [Tier1 · 리스크 낮음 · 독립롤백 O]

**파일**: 동. **앵커**: `resolveExecutor` 종료 직후(라인 132 `}` 다음)에 삽입.

**근거**: 단계 failover(P5)·병렬 재시도(P6)가 소비할 **단일 후보체인 소스**. `resolveExecutor`(및 5개 테스트) 무변경. `resolveExecutorChain(...)[0]`이 가용 우선 규칙상 `resolveExecutor(...)`와 동일 실행자를 내도록 정렬 → 배정 일관성. `pickAlternateExecutor`(P2-parallel) 대체.

**최종 코드**:
```ts

// 단계 failover용 실행자 후보 체인(우선순위·중복제거·순서유지).
// 1순위: 가용한 lead → 가용한 member(선언순) → 가용한 fallback.
// 2순위: (전원 리밋 대비) 등록됐지만 불가용일 수 있는 lead/member/fallback.
// resolveExecutorChain(...)[0] 은 resolveExecutor(...) 와 동일 실행자를 낸다.
export function resolveExecutorChain(
  team: TeamRow,
  knownAgents: Set<string>,
  fallback = 'ollama',
  isAvailable: AvailabilityFn = (id) => knownAgents.has(id),
): string[] {
  const chain: string[] = [];
  const push = (id: string | null | undefined) => {
    if (id && knownAgents.has(id) && !chain.includes(id)) chain.push(id);
  };
  if (team.lead && isAvailable(team.lead)) push(team.lead);
  for (const ref of team.members) if (isAvailable(ref)) push(ref);
  if (isAvailable(fallback)) push(fallback);
  push(team.lead);
  for (const ref of team.members) push(ref);
  push(fallback);
  return chain;
}
```
**독립 롤백**: 함수 삭제(P5/P6 미적용이면 무참조).
**효과 증명**: `tsc`→0. P9 신규 테스트에서 `resolveExecutorChain(team({lead:'opencode',members:['retired-provider','codex']}), known, 'ollama', avail)`(avail이 opencode만 배제)→`['retired-provider','codex','ollama','opencode']` assert. 31/31 유지.

---

## P4 — providerModelDispatchable 모델 사전검증 (R3)  [Tier1 · 리스크 낮음 · 독립롤백 O]

**파일**: 동. **앵커**: 라인 504 `const TERMINAL = new Set([...])` **위**에 삽입(상수 블록 상단).

**근거**: `ProviderModelNotFoundError`(172건)는 gateway가 응답문자열로 사후감지만 함. dispatch 전 (a)제거된 lead(mlx3/copilot 등)를 `getProvider` undefined로 즉시 배제, (b)api provider는 설정모델이 `/v1/models`에 존재하는지 60s TTL 캐시로 확인. CLI·모델미지정·조회실패는 보수적 통과(가용성 게이트가 2차 차단). P5/P6가 후보필터로 사용. ProviderConfig 필드(`type/model/endpoint/apiConfig.primary`) 실재 확인됨. Node≥22 → `AbortSignal.timeout` 사용가.

**최종 코드**:
```ts
// ── 모델 존재 사전검증(ProviderModelNotFoundError 선차단) ──
const MODEL_CACHE_TTL_MS = 60 * 1000;
const modelListCache = new Map<string, { at: number; models: Set<string> }>();

export async function providerModelDispatchable(id: string): Promise<boolean> {
  const provider = agentManager.getProvider(id);
  if (!provider) return false; // 제거된 lead(mlx3/copilot3 등) → 즉시 배제
  if (provider.type !== 'api') return true; // CLI/local 은 런타임 모델 해석 → 통과
  const wanted = provider.model || provider.apiConfig?.primary.model;
  if (!wanted) return true; // 서버 기본 모델 → 통과
  const baseUrl = provider.endpoint || provider.apiConfig?.primary.baseUrl;
  if (!baseUrl) return true; // 검증 불가 → 보수적 통과
  try {
    const cached = modelListCache.get(id);
    let models: Set<string>;
    if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) {
      models = cached.models;
    } else {
      const root = baseUrl.replace(/\/(v1\/?)?$/, '');
      const resp = await fetch(`${root}/v1/models`, { signal: AbortSignal.timeout(4000) });
      if (!resp.ok) return true; // 목록 조회 실패 → 보수적 통과
      const data = await resp.json() as { data?: Array<{ id?: string }> };
      models = new Set((data.data ?? []).map((m) => (m.id ?? '').toLowerCase()));
      modelListCache.set(id, { at: Date.now(), models });
    }
    if (models.size === 0) return true;
    const w = wanted.toLowerCase();
    return [...models].some((m) => m === w || m.startsWith(w.split(':')[0]));
  } catch {
    return true; // 네트워크 오류 → 보수적 통과
  }
}
```
**독립 롤백**: 함수+2상수 삭제(P5/P6 미적용이면 무참조).
**효과 증명**: `tsc`→0. `providerModelDispatchable('retired-local-provider')`→false(getProvider undefined, T1). ollama에 없는 태그 설정 후 `providerModelDispatchable('ollama')`→false, 존재 태그→true. 2회 연속 호출 시 2번째 fetch 미발생(TTL 캐시). 31/31 유지.

---

## P5 — 순차 파이프라인 stage failover (R4 + R5, verdict 최종-stage 예외 반영)  [Tier2 · 98% 최대 지렛대 · 리스크 중 · 독립롤백 △]

**파일**: 동. **앵커 2곳**:
1. 상수 추가: P4 삽입 블록 근처(예: `PIPELINE_HANDOFF_CHARS` 라인 508 아래)에 `MAX_STAGE_ATTEMPTS`.
2. pipeline 루프 교체: 라인 433–460(`// pipeline: 순차 실행…` 부터 `run.status = 'completed'; touch(run);`까지) 전체를, 아래 "루프 교체본"으로. `runStageWithFailover` 함수는 `dispatchStage` 함수(라인 463) **위**에 신규 추가.

**근거**: 현 루프는 dispatch 1회 실패/timeout/빈산출이면 **즉시 run failed**(all-or-nothing, 48% 실패 증폭 근본원인). 이를 후보체인(P3, stage.executor를 head로 seed → cap-3 역량선택 존중) × 모델검증(P4) × 최대 3회 재시도로 교체. **최종 stage(하류 없음)는 substantive 게이트 예외**(verdict: 캐스케이드 이득 0인데 완성률 순손실 방지). `dispatchStage/waitForTask/isSubstantiveOutput` 시그니처 불변. 이전단계 산출물 주입은 루프에서 `stage.subtask`에 prepend 후 호출 → `baseSubtask`로 재시도마다 보존.

**최종 코드 — 상수**:
```ts
const MAX_STAGE_ATTEMPTS = 3; // 초기 1 + 대체 2회
```

**최종 코드 — runStageWithFailover (dispatchStage 위에 신규)**:
```ts
// 단계를 후보 실행자 체인으로 failover 실행. completed && (최종stage거나 실질산출)이면 true.
async function runStageWithFailover(
  app: FastifyInstance, run: CompanyRun, stage: RunStage,
  team: TeamRow, projectDir: string, isLastStage: boolean,
): Promise<boolean> {
  const known = new Set(agentManager.listEnabledIds());
  const avail = liveAvailability(known);
  const roleChain = resolveExecutorChain(team, known, 'ollama', avail);
  // cap-3 역량 재선정으로 세팅된 stage.executor 를 attempt#1 로 seed(등록된 경우).
  const seeded = stage.executor && known.has(stage.executor)
    ? [stage.executor, ...roleChain.filter((x) => x !== stage.executor)]
    : roleChain;
  // R3 모델검증 통과 후보만, 최대 MAX_STAGE_ATTEMPTS
  const chain: string[] = [];
  for (const id of seeded) {
    if (await providerModelDispatchable(id)) chain.push(id);
    if (chain.length >= MAX_STAGE_ATTEMPTS) break;
  }
  const candidates = chain.length ? chain : [stage.executor];
  const baseSubtask = stage.subtask ?? '';
  let lastError = '';
  for (let i = 0; i < candidates.length; i++) {
    const exec = candidates[i];
    if (i > 0 && !avail(exec)) { lastError = `${exec} unavailable`; continue; }
    stage.executor = exec;
    stage.subtask = baseSubtask;
    stage.attempt = i + 1;
    stage.taskId = null;
    const ok = await dispatchStage(app, run, stage, projectDir);
    if (!ok || !stage.taskId) { lastError = stage.error ?? `${exec} dispatch failed`; continue; }
    stage.status = 'running'; touch(run);
    const result = await waitForTask(stage.taskId, PIPELINE_STAGE_TIMEOUT_MS);
    stage.status = (result.status as StageStatus) ?? 'failed';
    stage.outputSnippet = (result.response ?? '').slice(0, PIPELINE_HANDOFF_CHARS);
    stage.outputChars = (result.response ?? '').length;
    touch(run);
    // 최종 stage 는 하류 캐스케이드가 없으므로 substantive 게이트 예외(완성률 순손실 방지).
    const substantive = isLastStage || isSubstantiveOutput(result.response);
    if (result.status === 'completed' && substantive) {
      stage.error = undefined;
      return true;
    }
    lastError = result.status !== 'completed'
      ? `${exec} ${result.status}`
      : `${exec} insufficient output (${stage.outputChars}자)`;
    stage.error = lastError;
    log.warn({ runId: run.id, stage: stage.teamSlug, exec, attempt: i + 1, lastError },
      'stage attempt failed, trying next executor');
  }
  stage.status = 'failed';
  stage.error = `all executors failed: ${lastError}`;
  return false;
}
```

**최종 코드 — pipeline 루프 교체본(라인 433–460 대체)**:
```ts
  // pipeline: 순차 실행 + 이전 단계 산출물 주입 + 단계별 executor failover
  run.status = 'running'; touch(run);
  let prev: RunStage | null = null;
  for (let s = 0; s < run.stages.length; s++) {
    const stage = run.stages[s];
    const team = teamBySlug.get(stage.teamSlug)!;
    if (prev?.outputSnippet) {
      stage.subtask = `[이전 단계 '${prev.teamName}' 산출물]\n${prev.outputSnippet}\n\n---\n${stage.subtask ?? ''}`;
    }
    const isLast = s === run.stages.length - 1;
    const ok = await runStageWithFailover(app, run, stage, team, projectDir, isLast);
    if (!ok) {
      run.status = 'failed';
      run.error = `stage '${stage.teamSlug}' 모든 대체 실행자 실패. ${stage.executorNote ?? ''} ${stage.error ?? ''}`.trim();
      touch(run);
      return;
    }
    prev = stage;
  }
  run.status = 'completed'; touch(run);
```
**독립 롤백**: 루프 교체본→원본 블록 복원 + `runStageWithFailover`·`MAX_STAGE_ATTEMPTS` 삭제. P1~P4는 잔존해도 무해(P3/P4 무참조화).
**효과 증명**: `tsc`→0(P2 attempt 필드 선행 필수). 라이브 T1: lead=빈응답 provider, member=정상 provider 팀 → pipeline run → `GET run`에서 stage.attempt≥2·executor=member·status=completed·**run.status=completed**(1회 실패가 run 전체 미붕괴, tasks 2행). 전원 리밋 케이스→run.status=failed & stage.error=`all executors failed: …`. 31/31 유지(순수함수 테스트 무참조).

---

## P6 — 병렬 결과수집·게이트·재시도·집계 (R7 + P1-parallel + P2-parallel 통합)  [Tier2 · 98% 지렛대 · 리스크 중 · 독립롤백 △]

**파일**: 동. **앵커 2곳**:
1. 상수 추가(P5 상수 근처): `PARALLEL_STAGE_TIMEOUT_MS`, `PARALLEL_STAGGER_MS`.
2. parallel 블록 교체: 라인 423–431 전체를 아래 "블록 교체본"으로. 헬퍼 3개(`collectStage`/`retryFailedStagesParallel`/`finalizeParallel`)는 `waitForTask`(라인 523) 근처에 신규 추가.

**근거**: 현 병렬은 dispatch만 하고 `status='dispatched'`로 종료 → **성공/실패 판정 자체가 불가**(실패 100% 미관측). 결과를 `waitForTask` 병렬수집 + `isSubstantiveOutput` 게이트(verdict 공통지적: 빈응답 마스킹 차단) + 실패단계만 `resolveExecutorChain` 대체자로 1회 재시도(모델검증 P4) + `completed/partial/failed` 집계. `pickAlternateExecutor` 폐기(체인 재사용). HTTP 응답은 startCompanyRun에서 이미 즉시 반환 → 지연 없음(백그라운드 수명만 증가).

**최종 코드 — 상수**:
```ts
const PARALLEL_STAGE_TIMEOUT_MS = 15 * 60 * 1000; // 병렬 단계당 완료 대기 상한
const PARALLEL_STAGGER_MS = 400;                  // dispatch 스태거(로컬 단일스레드 보호)
```

**최종 코드 — parallel 블록 교체본(라인 423–431 대체)**:
```ts
  if (run.mode === 'parallel') {
    run.status = 'dispatching'; touch(run);
    const pKnown = new Set(agentManager.listEnabledIds());
    const pAvail = liveAvailability(pKnown);
    // 1) 전 단계 dispatch(스태거). 모델검증 통과한 가용 실행자로 재배정 후 1회 dispatch.
    for (const stage of run.stages) {
      const team = teamBySlug.get(stage.teamSlug)!;
      const chain = resolveExecutorChain(team, pKnown, 'ollama', pAvail);
      const seeded = stage.executor && pKnown.has(stage.executor)
        ? [stage.executor, ...chain.filter((x) => x !== stage.executor)]
        : chain;
      for (const c of seeded) { if (await providerModelDispatchable(c)) { stage.executor = c; break; } }
      await dispatchStage(app, run, stage, projectDir);
      await sleep(PARALLEL_STAGGER_MS);
    }
    // 2) 결과 동시 수집(waitForTask 병렬 + 빈 산출물 게이트).
    run.status = 'running'; touch(run);
    await Promise.all(run.stages.map((stage) => collectStage(stage, run)));
    // 3) 실패 단계만 대체 실행자로 1회 재시도.
    await retryFailedStagesParallel(app, run, teamBySlug, projectDir);
    // 4) 성공/실패 집계 → 터미널 상태 확정.
    finalizeParallel(run);
    return;
  }
```

**최종 코드 — 헬퍼 3개(waitForTask 근처 신규)**:
```ts
// 단일 단계 결과 수집: 완료 대기 → 산출물/상태 기록 → 빈 산출물 게이트.
async function collectStage(stage: RunStage, run: CompanyRun): Promise<void> {
  if (!stage.taskId) return; // dispatch 실패 — status 이미 'failed'
  stage.status = 'running'; touch(run);
  const result = await waitForTask(stage.taskId, PARALLEL_STAGE_TIMEOUT_MS);
  stage.outputSnippet = (result.response ?? '').slice(0, PIPELINE_HANDOFF_CHARS);
  stage.outputChars = (result.response ?? '').length;
  if (result.status === 'completed' && isSubstantiveOutput(result.response)) {
    stage.status = 'completed';
  } else if (result.status === 'completed') {
    stage.status = 'failed';
    stage.error = `insufficient output (${stage.outputChars}자)`;
  } else {
    stage.status = (result.status as StageStatus) ?? 'failed';
    stage.error = stage.error ?? `task ${result.status}`;
  }
  touch(run);
}

// 실패 단계만 대체 실행자(체인 다음 후보)로 1회 재시도(병렬).
async function retryFailedStagesParallel(
  app: FastifyInstance, run: CompanyRun,
  teamBySlug: Map<string, TeamRow>, projectDir: string,
): Promise<void> {
  const failed = run.stages.filter((s) => s.status !== 'completed' && (s.retryCount ?? 0) < 1);
  if (failed.length === 0) return;
  const known = new Set(agentManager.listEnabledIds());
  const avail = liveAvailability(known);
  await Promise.all(failed.map(async (stage) => {
    const team = teamBySlug.get(stage.teamSlug);
    if (!team) return;
    const chain = resolveExecutorChain(team, known, 'ollama', avail);
    let alt: string | null = null;
    for (const c of chain) {
      if (c === stage.executor) continue;
      if (await providerModelDispatchable(c)) { alt = c; break; }
    }
    if (!alt) return; // 유효한 대체자 없음 → 재시도 스킵
    stage.executorNote = `${stage.executorNote ? stage.executorNote + '; ' : ''}` +
      `실패(${stage.executor}) → 대체 실행자 '${alt}' 재시도`;
    stage.retryCount = (stage.retryCount ?? 0) + 1;
    stage.executor = alt;
    stage.taskId = null;
    stage.status = 'pending';
    stage.error = undefined;
    touch(run);
    const ok = await dispatchStage(app, run, stage, projectDir);
    if (ok && stage.taskId) await collectStage(stage, run);
  }));
}

// 병렬 집계: 성공/실패 카운트 → summary + 터미널 상태(completed/partial/failed).
function finalizeParallel(run: CompanyRun): void {
  const total = run.stages.length;
  const succeeded = run.stages.filter((s) => s.status === 'completed').length;
  const failed = total - succeeded;
  const retried = run.stages.filter((s) => (s.retryCount ?? 0) > 0).length;
  run.summary = { total, succeeded, failed, retried };
  run.status = failed === 0 ? 'completed' : succeeded > 0 ? 'partial' : 'failed';
  if (failed > 0) {
    run.error = `${failed}/${total} 단계 실패: ` +
      run.stages.filter((s) => s.status !== 'completed')
                .map((s) => `${s.teamSlug}(${s.executor})`).join(', ');
  }
  touch(run);
}
```
**의존**: P2(`partial`/`summary`/`retryCount`)·P3(체인)·P4(모델검증). **독립 롤백**: 블록 교체본→원본 복원 + 헬퍼3+2상수 삭제.
**효과 증명**: `tsc`→0. 라이브 T1: mode=parallel run → `GET runs/<id> | jq '.status,.summary'`→status가 `dispatched`가 아니라 completed|partial|failed & `summary.succeeded+summary.failed==summary.total`. lead=제거provider(mlx3) 팀 포함 → 해당 stage `retryCount==1`·executor 변경·executorNote '대체 실행자'. 31/31 유지.

---

## P7 — 역량기반 선정 순수함수 + imports (cap-1 + cap-2)  [Tier3 · 리스크 낮음 · 독립롤백 O]

**파일**: 동. **앵커 2곳**:
1. 라인 17 `import { circuitBreakerRegistry } …` 아래 3줄 import 추가.
2. `resolveExecutor` 종료 후(P3 `resolveExecutorChain` 앞뒤 어느 쪽이든, 권장: P3 다음)에 `CAPABILITY_CANDIDATES`+`selectCapabilityExecutor`+`reselectExecutor` 추가.

**근거**: verdict 평가상 역량 재선정은 "표면적"(all-or-nothing·모델층은 미해결)이라 **후순위**지만, 제거/깨진 lead를 subtask 유형(inferTaskType)로 우회해 172 잔여분·오배정을 줄인다. 순수함수(smartRouter/classifyTier 모두 DB 미접근) → 서버 없이 단위테스트 가능. `noUnusedLocals:false` 확인 → import 안전. smart-router는 company-orchestrator를 import 안 함 → 순환 없음.

**최종 코드 — imports**:
```ts
import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';
import { smartRouter } from './smart-router.js';
import { classifyTier, type Tier } from './tier-policy.js';
import type { TaskType } from './quality-gate.js';
```

**최종 코드 — 함수(그대로 채택; cap-2 원안)**:
```ts
// TaskType별 역량 우선순위 — 현재 가용 프로바이더만 역량 내림차순으로 나열.
const CAPABILITY_CANDIDATES: Record<TaskType, string[]> = {
  design:   ['opencode', 'claude-code', 'codex', 'agy', 'retired-provider'],
  code:     ['codex', 'opencode', 'hermes', 'cursor-agent', 'ollama'],
  review:   ['cursor-agent', 'codex', 'opencode', 'retired-provider', 'ollama'],
  verify:   ['ollama', 'hermes', 'retired-provider', 'codex', 'cursor-agent'],
  research: ['retired-provider', 'hermes', 'opencode', 'ollama', 'codex'],
  ui:       ['agy', 'opencode', 'codex', 'cursor-agent'],
  media:    ['agy', 'opencode', 'codex'],
  general:  ['codex', 'opencode', 'claude-code', 'hermes', 'ollama'],
};

export function selectCapabilityExecutor(
  subtask: string,
  knownAgents: Set<string>,
  fallback = 'ollama',
  isAvailable: AvailabilityFn = (id) => knownAgents.has(id),
): { executor: string; taskType: TaskType; complexity: number; tier: Tier } {
  const taskType = smartRouter.inferTaskType(subtask);
  const complexity = smartRouter.analyzeComplexity(subtask);
  const tier = classifyTier(subtask, complexity);
  const registered = (CAPABILITY_CANDIDATES[taskType] ?? CAPABILITY_CANDIDATES.general)
    .filter((id) => knownAgents.has(id));
  const live = registered.find((id) => isAvailable(id));
  if (live) return { executor: live, taskType, complexity, tier };
  if (registered.length) return { executor: registered[0], taskType, complexity, tier };
  const fb = (isAvailable(fallback) || knownAgents.has(fallback))
    ? fallback
    : ([...knownAgents][0] ?? fallback);
  return { executor: fb, taskType, complexity, tier };
}

export function reselectExecutor(
  team: TeamRow,
  subtask: string,
  knownAgents: Set<string>,
  fallback = 'ollama',
  isAvailable: AvailabilityFn = (id) => knownAgents.has(id),
): { executor: string; taskType: TaskType; note?: string } {
  if (team.lead && knownAgents.has(team.lead) && isAvailable(team.lead)) {
    return { executor: team.lead, taskType: smartRouter.inferTaskType(subtask) };
  }
  const cap = selectCapabilityExecutor(subtask, knownAgents, fallback, isAvailable);
  const reason = !team.lead ? 'lead 미지정'
    : !knownAgents.has(team.lead) ? `lead '${team.lead}' 제거/미등록`
    : `lead '${team.lead}' 서킷 open/불가용`;
  const note = `${reason} → 역량매칭(${cap.taskType}) '${cap.executor}' 재선정`;
  return { executor: cap.executor, taskType: cap.taskType, note };
}
```
**독립 롤백**: 3 import + 함수블록 삭제(P8 미적용이면 무참조).
**효과 증명**: `tsc`→0. P9 테스트로 검증(아래). 31/31 유지.

---

## P8 — driveRun 역량 재선정 배선 (cap-3)  [Tier3 · 리스크 중 · 독립롤백 O]

**파일**: 동. **앵커**: 라인 414–419 step2(subtask 확정 for-루프 + `touch(run)`) **직후**, `if (run.dryRun)` (라인 421) **앞**에 삽입.

**근거**: subtask 확정 후·dispatch 전에, 깨진/제거 lead를 무시하고 subtask 유형 기준 최신 가용 provider로 재배정. lead 유효·가용시 팀설계 존중 유지. pipeline·parallel **공통 상류**라 양 모드 커버. P5/P6가 `stage.executor`를 체인 head로 seed하므로 chain[0]=역량선택으로 일관.

**최종 코드(라인 419 `touch(run);` 다음 삽입)**:
```ts

  // 2.5) 역량 기반 실행자 재선정 — subtask 확정 후 dispatch 전, 깨진/제거 lead 를 무시하고
  //      subtask 유형(inferTaskType)으로 현재 가용 프로바이더 중 최적 실행자 재배정.
  //      lead 가 유효·가용하면 팀 설계 존중해 유지. 분해 대기 이후 fresh availability 사용.
  const knownNow = new Set(agentManager.listEnabledIds());
  const availNow = liveAvailability(knownNow);
  for (const stage of run.stages) {
    const team = teamBySlug.get(stage.teamSlug)!;
    const before = stage.executor;
    const sel = reselectExecutor(team, stage.subtask ?? '', knownNow, 'ollama', availNow);
    stage.executor = sel.executor;
    if (sel.note) stage.executorNote = sel.note;
    if (sel.executor !== before) {
      log.info({ runId, team: stage.teamSlug, before, after: sel.executor, taskType: sel.taskType },
        'capability re-selection');
    }
  }
  touch(run);
```
**의존**: P7. **독립 롤백**: 이 블록 삭제(P5/P6는 stage.executor를 startCompanyRun 초기값으로 seed → 정상 동작).
**효과 증명**: `tsc`→0. 라이브: 제거 lead(retired-local-provider) 팀 run 후 `stages[*].executor`가 현재 가용 provider·executorNote '역량매칭' 기록. 31/31 유지(driveRun 미호출).

---

## P9 — 신규 테스트 파일 (cap-4/4b + reliability)  [Tier4 · 리스크 없음 · 독립롤백 O]

**파일**: **신규** `src/core/company-orchestrator.reliability.test.ts` (원 test 파일 무수정 → 기존 31 보존).

**근거**: 신규 export(resolveExecutorChain/selectCapabilityExecutor/reselectExecutor) 순수함수 회귀 방어. 서버 불필요.

**최종 코드(핵심 발췌; providerModelDispatchable는 fetch 의존이라 단위테스트 제외 → P4 라이브 증명으로 대체)**:
```ts
import { describe, it, expect } from 'vitest';
import {
  resolveExecutorChain, selectCapabilityExecutor, reselectExecutor, type TeamRow,
} from './company-orchestrator.js';

const team = (p: Partial<TeamRow> & { slug: string; name: string }): TeamRow =>
  ({ id: `t_${p.slug}`, lead: null, charter: null, description: null, members: [], ...p });

describe('resolveExecutorChain', () => {
  it('가용 우선 + 등록 후보 후행', () => {
    const known = new Set(['opencode', 'retired-provider', 'codex', 'ollama']);
    const avail = (id: string) => id !== 'opencode' && known.has(id);
    expect(resolveExecutorChain(team({ slug: 'a', name: 'A', lead: 'opencode', members: ['retired-provider', 'codex'] }), known, 'ollama', avail))
      .toEqual(['retired-provider', 'codex', 'ollama', 'opencode']);
  });
  it('chain[0] === resolveExecutor 반환(가용 lead)', () => {
    const known = new Set(['codex', 'ollama']);
    expect(resolveExecutorChain(team({ slug: 'a', name: 'A', lead: 'codex' }), known)[0]).toBe('codex');
  });
});

describe('selectCapabilityExecutor', () => {
  it('code 유형 → codex, 제거 provider 미반환', () => {
    expect(selectCapabilityExecutor('버그 수정·기능 구현', new Set(['ollama','retired-provider','codex','opencode'])).executor).toBe('codex');
  });
  it('codex 미등록이면 역량순 가용 폴백', () => {
    const r = selectCapabilityExecutor('코드 구현 수정', new Set(['ollama','retired-provider']));
    expect(['retired-local-provider','copilot','openrouter']).not.toContain(r.executor);
    expect(r.executor).toBe('ollama');
  });
  it('전원 서킷 open → 등록된 첫 후보', () => {
    expect(selectCapabilityExecutor('코드 구현', new Set(['codex','ollama']), 'ollama', () => false).executor).toBe('codex');
  });
});

describe('reselectExecutor', () => {
  const known = new Set(['opencode','codex','cursor-agent','ollama','agy','hermes','retired-provider','claude-code']);
  it('lead 유효·가용 → 유지(note 없음)', () => {
    const r = reselectExecutor(team({ slug:'a', name:'A', lead:'codex' }), '코드 구현', known);
    expect(r.executor).toBe('codex'); expect(r.note).toBeUndefined();
  });
  it('제거 lead → 역량 재선정 + note', () => {
    const r = reselectExecutor(team({ slug:'a', name:'A', lead:'retired-local-provider' }), '아키텍처 설계', known);
    expect(r.executor).toBe('opencode'); expect(r.note).toMatch(/제거\/미등록/);
  });
});
```
**독립 롤백**: 파일 삭제.
**효과 증명**: `npx vitest run src/core/company-orchestrator.reliability.test.ts`→green + 기존 `company-orchestrator.test.ts`→31/31.

---

## P10 — DECOMPOSER_PREFS 위생 (제거된 'retired-local-provider' 제거)  [Tier4 · 리스크 낮음 · 독립롤백 O]

**파일**: 동. **앵커**: 라인 137.

**근거**: 메모리 T1(retired-local-provider fleet-wide 제거, ollama 단일화). availability 필터로 무해하나 stale. 순서 의미 불변.

**최종 코드**:
```ts
const DECOMPOSER_PREFS = ['opencode', 'claude-code', 'retired-provider', 'codex', 'ollama'];
```
**주의(테스트)**: `resolveDecomposers` 테스트(라인 127) `['retired-provider','opencode','claude-code','codex','ollama']`는 known에 retired-local-provider 미포함이라 **영향 없음**. 검증: 31/31 유지.
**독립 롤백**: 'retired-local-provider' 재삽입.

---

## 적용 순서·의존 그래프

```
P1(rate-limit)   독립
P2(types)        독립 → P5,P6 선행필수
P3(chain)        독립 → P5,P6 소비
P4(model)        독립 → P5,P6 소비
P5(pipeline failover)   ⇐ P2,P3,P4        [98% 최대 지렛대]
P6(parallel collect)    ⇐ P2,P3,P4        [98% 지렛대]
P7(capability fns)      독립 → P8 소비
P8(reselect wiring)     ⇐ P7 ; P5/P6와 seed 정렬(공존)
P9(tests)               ⇐ P3,P7
P10(hygiene)            독립
```
최소 도입(리스크 최저·즉효): **P1 → P2 → P3 → P4 → P5 → P6**. 이 6개만으로 all-or-nothing(순차)·fire-and-forget(병렬)·172·리밋27을 직접 감축. P7/P8(역량)·P9/P10은 후속.

## 검증 영수증
- [변경] 없음(read-only 합성 스펙). 대상 `src/core/company-orchestrator.ts`(536L) 및 의존 모듈 대조.
- [검증방법] 대상 파일 전문 Read + `company-orchestrator.test.ts`(31케이스) Read로 lock-in 계약 확인 / `npx tsc --noEmit`→exit0 / `npx vitest run src/core/company-orchestrator.test.ts`→31 passed / `grep` smart-router(inferTaskType·analyzeComplexity public, 250 smartRouter export)·tier-policy(classifyTier·Tier)·quality-gate(TaskType 8종)·config.ts(ProviderConfig type/model/endpoint/apiConfig.primary)·007 마이그(rate_limit_state agent_id·is_limited)·tsconfig(noUnusedLocals:false)·`git status`(파일 untracked)
- [등급] T1 (파일·테스트·타입검사·마이그·git 상태 직접 확인)
- [Gap] 85% — 앵커·시그니처·타입·기존테스트·의존심볼 실재 전부 T1 확인. 각 패치 스니펫은 확인된 API에만 의존(컴파일 정합성 정적확증). 미적용 상태라 병합 후 실제 `tsc`/`vitest` 실행 및 라이브 company run은 미수행.
- [미검증항목] (a) 10패치 병합 적용 후 실제 `tsc --noEmit`·`vitest` 결과, (b) 실 org/team 픽스처로 pipeline·parallel 라이브 run(P5 재시도·P6 partial/summary 실동작), (c) `providerModelDispatchable`의 ollama `/v1/models` 실응답 형태, (d) cap-3 재선정이 UI에 노출되는 실제 직렬화 — 전부 정적 대조 기반(라이브 미수행).
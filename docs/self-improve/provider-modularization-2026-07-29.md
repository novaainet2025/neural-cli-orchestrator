# 프로바이더 모듈화 — 근본원인과 조치 (2026-07-29)

> 계기: nvidia 프로바이더 1개를 퇴출하는 데 **41개 소스 파일 + 5개 마이그레이션 +
> 14개 훅/커맨드**를 손으로 고쳐야 했다. 이 비용 자체가 결함이다.
> 맥락은 `docs/history/맥락노트-2026-07-29.md`.

---

## 1. 근본원인 (T1)

프로바이더 목록의 SSOT는 `config/ai-providers.json`인데, **라우팅 코드가 그것을
읽지 않고 id를 하드코딩**하고 있었다. 실측:

```
$ grep -rlE "'(claude-code|opencode|codex|cursor-agent|ollama|agy|hermes|higgsfield)'" src --include='*.ts' | grep -v test
41 files
```

그 결과 두 방향으로 어긋난다:

**(a) 삭제해도 코드에 남는다** — 프로바이더를 config에서 지워도 순서표에는 남아,
지웠다고 믿는 상태에서 후보 목록에 계속 등장한다.

**(b) 이미 어긋나 있었다** — 발견된 유령 id:

| 위치 | 유령 id | 상태 |
|---|---|---|
| `src/core/adaptive-scorer.ts` COLD_START_PRIORS | `copilot` | config에 없음 |
| `src/core/tier-policy.ts` WORKER_TIER | `aider` | config에 없음 |
| `src/discussion/report-generator.ts:77` | `gemini-api` | config에 없음 |

즉 문제는 "nvidia를 지우기 어렵다"가 아니라 **"프로바이더 목록과 라우팅 코드가
구조적으로 동기화되지 않는다"**였다.

## 2. 조치

### 2.1 `src/core/provider-registry.ts` — 라우팅 해석 계층

기존 `ProviderRegistry` 클래스(부팅 시 init 필요, enabled만)는 그대로 두고,
init 없이 config를 직접 읽는 함수 계층을 추가했다. 라우팅 표는 모듈 로드 시점에
평가되는 곳이 많아 부팅 순서에 의존할 수 없기 때문이다.

계약:

1. 등록 여부의 기준은 **오직 config** (`ai-providers.json` + `.local` 오버레이)
2. 코드의 순서표는 **큐레이션된 힌트**일 뿐 — 미등록 id는 런타임에 걸러진다
3. 순서표에 없어도 등록돼 있고 역량이 맞으면 **뒤에 자동 편입**된다

핵심 함수 `resolvePreference(declared, taskType?)`:

```
[큐레이션 순서 중 등록된 것]  ++  [순서표에 없지만 역량이 맞는 등록 프로바이더]
```

앞부분이 **기존 동작을 그대로 보존**하고(회귀 없음), 뒷부분이 **신규 자동 편입**을 만든다.
`taskType` 생략 시 필터링만 한다(순서 자체가 정책인 경우: management 계층 등).

자동 편입 순위는 id가 아니라 **capability 토큰**으로 매긴다
(`가중치 = 매칭 capability 수 × 1000 + provider.score`). 프로바이더가 늘어도
`TASK_CAPABILITIES` 표는 바뀌지 않는다.

`derivedTier(id)`는 순서표에 이름이 없는 신규 프로바이더를 config의 `cost`/`type`으로
분류한다 (`local` 또는 `free` → worker, `paid` → brain).

### 2.2 라우팅 테이블을 레지스트리로 통과

| 파일 | 변경 |
|---|---|
| `company-orchestrator.ts` | `CAPABILITY_CANDIDATES` 읽기 → `resolvePreference(…, taskType)`, `DECOMPOSER_PREFS` 2곳 → 필터링 |
| `tier-policy.ts` | `BRAIN_SET`/`WORKER_SET` → `filterRegistered`, `tierOf`의 unknown → `derivedTier` 폴백, `LAYER_TIER_AGENTS` 4계층 전부 |
| `discussion-engine.ts` | 종합자 우선순위 |
| `ensemble-engine.ts` | 기본 앙상블 (general 자동 편입) |
| `harness-orchestrator.ts` | `TASK_AGENTS` 읽기 |
| `work-report-scheduler.ts` | 보고 가능 폴백 우선순위 |

### 2.3 `scripts/provider.ts` — add/remove CLI

```
npm run provider:list
npm run provider:add    -- <id> --role Reasoner --type api --caps reasoning,analysis
npm run provider:remove -- <id>            # dry-run (기본)
npm run provider:remove -- <id> --apply
```

`remove`가 처리하는 것: config 항목 · local 오버레이 · failover 체인(자기 체인 +
타 체인 내 등장) · 팀/조직 재배정 마이그레이션 생성 · hnsw 인덱스 삭제.

**생성되는 마이그레이션은 086 계약을 지킨다** — 팀 lead를 *데이터 기반으로*
그 팀의 남은 멤버 중에서 고르고, team_members 삭제보다 **먼저** 수행한다
(순서를 바꾸면 후보가 사라진다). `nco-government` manager만 `hermes`로 따로 잡는다
(헌정 5사 manager 유일성).

**일부러 자동화하지 않은 것** — 판단이 필요해 사람 몫으로 남기고 실행 후 안내한다:
`.env` API 키(다른 용도 가능), 과거 실행기록(증거), 문서 본문(기록 개작은 별도 결정),
vault의 `01-AGENTS/<id>.md`.

### 2.4 `tests/provider-drift.test.ts` — 드리프트 감시

두 축으로 지킨다:

- **결과 검사(엄격)**: tier 순서표·4-Layer 배정·`capabilityRank`·`resolvePreference`가
  내놓는 후보에 미등록 id가 하나도 없어야 한다. 등록된 모든 프로바이더는
  `tierOf`가 `unknown`을 반환하지 않아야 한다.
- **신규 하드코딩 차단**: src를 훑어 "프로바이더 목록으로 보이는 덩어리"에서
  미등록 id를 찾는다. 기존 유령 70건은 `KNOWN_LEGACY_IDS`로 동결하고,
  **여기 없는 새 id가 등장하면 실패**한다.

판별 휴리스틱(중요): 배열/객체 리터럴 안에 **등록 프로바이더가 2개 이상**이고
**인식된 id가 과반**일 때만 "프로바이더 표"로 본다. 처음엔 "알려진 id만 검사"하는
로직을 썼는데, 그러면 **정작 새 유령은 영원히 통과**한다 — 음성 테스트(가짜 nvidia
주입)로 이 결함을 잡았다.

## 3. 검증 (T1)

**동작 증명 — 실제 add/remove 왕복:**

```
$ npm run provider:add -- zzz-probe --role Reasoner --type api \
    --caps reasoning,analysis,review --score 99 --apply
  ✓ config/ai-providers.json — 'zzz-probe' 항목 추가

$ npx tsx (registry probe)
  isRegistered(zzz-probe): true
  capabilityRank(research): hermes, zzz-probe, ollama, opencode, agy, cursor-agent
  derivedTier(zzz-probe): worker
```
→ **코드 수정 0줄로 라우팅에 편입됐다.**

```
$ npm run provider:remove -- zzz-probe --apply
  ✓ config 항목 삭제  ✓ 마이그레이션 생성

  isRegistered(zzz-probe): false
  capabilityRank(research): hermes, ollama, opencode, agy, cursor-agent
  derivedTier(zzz-probe): unknown
```
→ **코드 수정 0줄로 모든 라우팅에서 사라졌다.** 프로바이더 로스터는 작업 전과 동일
(diff는 `updated` 날짜 1줄).

**생성된 마이그레이션 실검증:** 빈 DB에 전량 재생 → 실패 0,
`teams.lead ∉ team_members` 위반 0.

**드리프트 가드 음성/양성:**

| 트리 상태 | 결과 |
|---|---|
| 정상 | 7/7 passed |
| `harness-orchestrator`의 media에 `'nvidia'` 주입 | **FAIL** — `src/core/harness-orchestrator.ts: 'nvidia'` |
| 복원 | 7/7 passed |

**회귀:** `npx tsc --noEmit` exit 0 / 오류 0 · `npx vitest run` **888/888 passed,
135/135 files** · `npm run build` exit 0.

가드가 실제 드리프트 1건을 잡아 수정했다: `report-generator.ts:77`의 `gemini-api`
(데모 픽스처의 가짜 참가자명) → `codex`.

## 4. 남은 것

- `src`의 유령 id 70건(`aider`·`copilot`·`openrouter`·`mlx`·`openclaw`·`openai`·`vllm`)은
  `KNOWN_LEGACY_IDS`로 동결만 했다. 정리할 때 목록에서 지우면 재유입이 차단된다.
- `adaptive-scorer`의 cold-start prior는 손으로 관리하는 경험값이라 표 자체는 이력으로
  남겼다(후보 목록이 등록된 것만 담으므로 유령 prior는 자연히 무시된다).
- `provider:add`는 `enabled=false`로 등록한다 — 명령/키 확인 전 자동 투입 방지.
- 미커밋.

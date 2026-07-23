done: [Evidence Tier 1] 지정 스펙, 02 안전·라이선스, 03 복구, 04 기준선, 05 격리 A/B 및 현재 코드 경계를 직접 대조해 06 개선 방향을 확정했습니다.

# cli-extensions → nova-use 브라우저 제어 이식: 개선 방향 결정

- 검토일: 2026-07-23 (Asia/Seoul)
- 하위작업: 06 개선 방향 토론팀
- 범위: P1 심층 이해, P2 공유 학습, P3 Force 검증 래더, P4 자율 착수·파괴적 동작 게이트
- 결정: `CONDITIONAL_GO_NATIVE_PARTIAL_PORT_WITH_THIN_ADAPTERS`
- 구현 상태: `NOT_STARTED_BY_THIS_STAGE`
- 프로토타입 판정: `FEATURE_PASS / LEGACY_PARITY_PASS / MICROPERF_ALERT`
- 제품 성능 판정: `UNKNOWN` — 격리 Node 마이크로벤치마크는 Electron/WebContents 제품 경로를 포함하지 않음
- 활성화 판정: P1/P3 구현 `CONDITIONAL_GO`, P2/P4 및 배포 `NO_GO_UNTIL_SAFETY_GATES_CLEAR`

## 1. 결론

P1~P4 전체 기능 범위는 유지하되, 원본 코드를 직접 이식하지 않는다. 최종
전략은 **nova-use 고유 실행 경계 위의 부분 포팅 + 얇은 Electron
어댑터**다.

1. P1의 comprehension, affordance, playbook은 기존
   `snapshotRuntimeBrowserTab()`의 stable ref를 입력으로 삼는 결정론적
   순수 로직으로 작성한다. 현재 snapshot에 없는 최소 신호만 정적
   `executeJavaScript` 수집기로 보완한다.
2. P2는 원본 저장소의 동작 계약을 oracle로 삼되, nova-use
   `app.getPath("userData")` 아래 500건 제한 JSON 저장소로 clean-room
   구현한다. nco나 nova-ax를 런타임 의존성으로 연결하지 않는다.
3. P3는 기존 FORCE 진입점, preflight, CDP allowlist를 감싸는 검증 래더만
   추가한다. 대상 한정 `MutationObserver`가 효과를 확인하지 못했을 때만
   기존 CDP 경로로 승격한다.
4. P4의 `safeToAutostart`는 계획 힌트일 뿐 권한 판정이 아니다.
   destructive 분류를 실행 직전 policy/consent 경계에서 다시 평가하고,
   파괴적이거나 불명확한 동작은 `autoApprove` 및 remembered consent로
   자동 해제할 수 없게 한다.

03단계에서 fresh checkpoint와 격리 worktree가 생성돼 복구 게이트는
`READY`다. 05단계 격리 프로토타입도 61/61 gap-contract 정확도와
legacy digest parity 100%를 보였으므로, 구현은
`/Users/nova-ai/project/nova-use-browser-control-port`에서 시작할 수 있다.
다만 dirty 핵심 10파일의 소유자/hunk 조정 없이 main worktree를
덮어쓰면 안 된다.

P2/P4 활성화와 배포는 계속 보류한다. destructive 요청이 generic
auto/remembered consent에 흡수되는 문제, 앱 외 공유 홈 저장 문제,
permission handler 부재, lockfile/SBOM/license/CVE 미확정이 남아 있다.
또한 후보의 평균 지연은 1.67→5.65 µs/op(+238.90%), peak RSS는
55.91→64.20 MiB(+14.84%)였으므로 성능 향상은 주장하지 않는다. 절대
지연은 작지만 제품 경로 영향은 Electron 통합 A/B 전까지 미확정이다.

## 2. 검토한 근거

| 근거 | 실제 확인 내용 | 이 결정에 미친 영향 |
|---|---|---|
| `nova-use/docs/plans/browser-control-extension-port.md` | chrome.* 복붙 금지, 기존 ref/FORCE/CDP/deepInspect/capture/PolicyEngine 재구현 금지, P1~P4 및 T1 요구 | 직접 이식과 새 브라우저 드라이버를 제외 |
| `nova-use/src/main/agent-browser-adapter.ts:151-405,440-483` | ANALYZE/INSPECT/action dispatch가 한 경계에 모여 있고, 현재 page digest는 얕으며 FORCE는 `forced:false, note:'degraded'`로 일반 click/input에 위임 | P1/P2/P3의 최소 결합 지점을 adapter로 선정 |
| `nova-use/src/shared/ipc.ts:895-903` | `BrowserAgentPageDigest`에 comprehension/affordance/playbook 계약이 없음 | P1은 IPC 타입 확장부터 시작 |
| `nova-use/src/main/browser.ts:1530-1590,1783-1790` | query/click/input과 `executeJavaScript`가 기존 policy gate 및 preflight를 사용 | 새 실행기를 만들지 않고 검증 래더만 추가 |
| `nova-use/src/shared/capability.ts` | L0 allow, L1/L2 ask, L3/L4 block 기본값과 CDP 등급별 allowlist가 이미 있음 | P3 CDP 승격은 기존 등급·allowlist를 그대로 사용 |
| `nova-use/src/main/browser-consent.ts` | 세션 `autoApprove`와 origin/tool 단위 remembered approval이 ASK를 자동 승인할 수 있음 | destructive는 일반 approval 캐시보다 강한 별도 불변식 필요 |
| `nova-use/src/main/agent-control.ts` | 명시적 goal/exec/analyze 흐름은 있으나 무지시 autostart와 destructive 실행 직전 강제 규칙은 없음 | P4는 agent-control 계획과 policy/consent 실행 경계 모두에 연결 |
| `cli-extensions/extension/src/content/page-digest.ts` | comprehension/affordance/autoMission/safeToAutostart 동작 oracle 존재 | 기능 의미와 fixture 예상값만 참조 |
| `cli-extensions/extension/src/content/force.ts` | 대상 한정 효과 감시와 단계별 force 동작 oracle 존재 | WebContents용 검증 계약을 설계하되 코드 복사 금지 |
| `cli-extensions/extension/src/shared/destructive.ts` | 한·영 파괴적 라벨 분류 예시 존재 | 분류 fixture 후보로만 사용; 실행 게이트는 nova-use에서 재설계 |
| `nco/src/core/reflexion.ts` | 이전 회고 recall 후 재시도하는 순서가 존재 | P2 학습 순서 참고만; mem0 결합 제외 |
| `nova-ax/src/core/memory-system.ts` | SQLite/FTS 및 embedding recall이 존재 | 500건 로컬 요구에는 과대하므로 향후 선택적 backend로만 유지 |
| `data/team-runner/team_tech-port-02-safety-license-2026-07-23.md` | 구현 조건부 GO, P2/P4·배포 NO-GO; 12개 findings와 격리 정책 | 새 dependency와 원본 실행 코드 이식 금지, P2/P4 활성화 gate 유지 |
| `REPORTS/technology-porting/browser-control-extension-port-recovery-checkpoint-2026-07-23.md` | fresh checkpoint/설정 백업/세 격리 worktree를 생성해 `RECOVERY_GATE: READY`; nova-use 핵심 10파일 dirty | 격리 nova-use worktree에서만 구현, main dirty 덮어쓰기 금지 |
| `docs/plans/browser-control-benchmark-20260723-v5/baseline-summary.md` | 세 프로젝트 cold/warm build/test/CPU/RSS 기준선 보존; nova-use focused 4 files/44 tests PASS, 전체 suite RED | focused 회귀선은 사용하되 회사 T1 대체 금지 |
| `docs/plans/browser-control-port-ab-20260723/{ab-summary.md,raw.jsonl,environment.json}` | 7 fresh processes × variant, 각 40,000 ops; gap 61/61, legacy parity 100%, 오류 0/280,000, 지연/RSS 경고 | 기능 전략은 지지하지만 제품 성능·Electron 통합은 미확정 |
| `data/team-runner/team_tech-port-05-upgrade-regression-2026-07-23.md` | 먼저 생성된 팀 보고서는 A/B 미확인으로 기록 | 후속 timestamped raw A/B 증거와 충돌하므로 최신 원시 산출물을 우선 |

## 3. 선택지 비교

| 선택지 | 적합한 부분 | 비용·위험 | 결정 |
|---|---|---|---|
| 직접 이식 | 동일 런타임·API일 때 빠를 수 있음 | 원본은 Chrome MV3/content script/chrome.debugger 기반이라 Electron WebContents와 권한 경계가 다름. 복붙 금지 및 라이선스 미확인에도 위배 | **거부** |
| 래퍼/어댑터 | WebContents 실행, CDP 승격, 저장소 I/O처럼 플랫폼 경계를 격리 | 지나치게 넓으면 기존 adapter/browser 계층과 중복되고 오류 의미가 흐려짐 | **부분 채택** — 플랫폼 경계에만 얇게 사용 |
| 부분 포팅 | P1 순수 추론, P2 fingerprint/guard, P3 효과 receipt, P4 분류 계약처럼 가치 있는 능력만 옮길 수 있음 | 책임 경계와 데이터 계약을 먼저 고정해야 함 | **주 전략으로 채택** |
| 자체 재구현 | Electron 권한·저장소·감사 요구에 맞춘 glue 구현에 적합 | 원본 기능을 전면 재작성하면 동작 회귀와 검증 비용이 큼 | **제한 채택** — Electron 어댑터와 로컬 저장소만 clean-room 구현 |
| 보류 | 측정·권리·복구 근거가 없는 부분의 사고 방지 | 전체 일정 지연 | **부분 채택** — 성능 주장, 외부 공유 backend, 배포는 보류 |
| 거부 | 새 드라이버, DB migration, 원격 메모리 필수화처럼 범위가 커지는 안을 차단 | 향후 확장 선택지가 늦어질 수 있음 | **명시 거부** — 현재 P1~P4에 불필요 |

### 반대 의견과 답변

- **“원본을 그대로 옮기면 가장 빠르다.”** Chrome extension의 content
  script 생명주기와 `chrome.debugger` 소유권은 Electron WebContents의
  실행·consent 경계와 다르다. 빠른 복사는 기존 policy/preflight를
  우회하거나 중복시킬 가능성이 높고 제품 스펙에도 위배된다.
- **“세 프로젝트가 학습 DB 하나를 공유해야 진짜 공유 학습이다.”**
  브라우저 action fingerprint는 앱 사용자 데이터이며, nco/mem0 또는
  nova-ax 장애를 브라우저 실행 경로에 전파하면 안전성과 복구성이
  낮아진다. 우선 nova-use 앱 내 recall을 완성하고, 외부 공유는 명시적
  opt-in의 마스킹된 비동기 export 계약으로 별도 검증한다.
- **“모든 P1~P4 코어를 즉시 공용 패키지로 만들자.”** 현재 실제 소비자는
  nova-use 하나다. 두 번째 소비자가 같은 계약을 구현하기 전 패키지를
  만들면 가상 공통화가 되고, 세 프로젝트 release cadence가 결합된다.
  지금은 타입·fixture·receipt 형식만 공통 계약 후보로 고정한다.
- **“safeToAutostart가 true면 기존 autoApprove로 충분하다.”**
  `safeToAutostart`는 페이지 해석 결과이며 보안 주체가 아니다. 라벨 오판,
  페이지 변화, stale ref를 고려해 실행 직전 destructive 판정과 fresh
  target identity 확인이 반드시 다시 필요하다.

## 4. P1~P4별 구현 방식

| 단계 | 채택 방식 | nova-use의 기존 기반 | 새 책임 | 금지선 |
|---|---|---|---|---|
| P1 | 부분 포팅 + 최소 page-world 수집 어댑터 | stable refs, snapshot, deepInspect | IPC contract, deterministic comprehension/affordance/playbook, 최소 DOM 신호 수집 | 새 ref/AX/CDP snapshot 시스템 금지 |
| P2 | clean-room 로컬 모듈 + adapter hook | 단일 execute 경계, Electron userData | redacted fingerprint, 성공/실패, recall/lesson/done, 동일 page signature 반복 실패 차단, 500건/원자 저장 | raw input/DOM/API key/email 저장, nco/nova-ax 필수 의존 금지 |
| P3 | 기존 FORCE를 감싸는 검증 어댑터 | FORCE action, preflight token, click/input, CDP allowlist | target effect receipt, DOM rung 결과, 실패 시 명시적 `escalate:'cdp'` | 새 CDP dispatcher, 임의 Runtime.evaluate, policy 우회 금지 |
| P4 | 계획 힌트 + 실행 직전 강제 게이트 | PolicyEngine, ConsentBroker, agent-control | conservative destructive classifier, autostart eligibility, fresh consent 불변식 | prompt-only 보호, autoApprove/remembered approval로 destructive 자동 승인 금지 |

P4의 실행 규칙은 다음 순서를 고정한다.

1. 최신 snapshot/preflight로 target identity와 page signature를 확인한다.
2. action, affordance intent, label, task type을 이용해 destructive를 다시
   분류한다.
3. `destructive=true` 또는 분류가 불명확하면 autostart를 중지한다.
4. 기존 PolicyEngine이 block이면 즉시 차단한다.
5. ask인 destructive action은 매 실행마다 fresh explicit consent를
   요구한다. 세션 autoApprove와 remembered approval은 적용하지 않는다.
6. 실행 후 감사 receipt와 P2 성공/실패 fingerprint를 남긴다.

## 5. 세 프로젝트 공통화 경계

### 지금 공통 계약으로 고정할 것

공통화는 코드를 한 저장소에 묶는 것이 아니라, 다음의 직렬화 가능한
계약과 fixture 의미를 일치시키는 수준으로 시작한다.

| 공통 계약 후보 | 최소 필드 | 비고 |
|---|---|---|
| page/action identity | schemaVersion, origin/domain, pageSignature, action, ref/selector fingerprint, frame | raw selector를 외부 공유할 때는 hash/정규화 정책 필요 |
| learning receipt | outcome, strategy, failureCode, createdAt, evidenceKind | 입력 원문과 페이지 본문 금지 |
| repeat-guard decision | allowed, code=`repeated_failed_action`, matchingFingerprint | 실행 전 결정론적으로 평가 |
| destructive decision | destructive, confidence/uncertain, matchedReason, requiresFreshConsent | `safeToAutostart`와 분리 |
| force receipt | rung, targetChanged, evidence, escalate | CDP params나 비밀값을 포함하지 않음 |
| benchmark row | variant, fixture, iteration, success, errorCode, latencyMs, cpuMs, rssBytes | 05단계 재실행 시 동일 형식 사용 |

이 계약은 우선 nova-use 내부 타입과 fixture로 둔다. nco 또는 nova-ax가
실제 두 번째 소비자가 되고 호환성 테스트가 생길 때만 독립 공용
패키지를 검토한다.

### 프로젝트별로 남길 것

| 프로젝트 | 소유할 책임 | 공통화하지 않을 부분 |
|---|---|---|
| nova-use | 유일한 브라우저 실행 주체, WebContents/CDP 어댑터, preflight, consent/policy, 500건 앱 로컬 learning store | Electron 객체, tab ownership, userData 경로, browser UI/IPC |
| nco | 향후 선택적 orchestration 및 마스킹된 lesson 수신 후보 | 브라우저 action 실행, consent 판단, nova-use 사용자 데이터 직접 읽기, mem0를 동기 실행 의존성으로 제공 |
| nova-ax | 대규모 장기 recall이 실제 필요해질 때 선택 가능한 비동기 검색 backend 후보 | 500건 앱 로컬 기본 저장소, Electron lifecycle, policy/consent |
| cli-extensions | 동작 oracle와 회귀 fixture의 의미 제공 | Chrome API, content script/bridge/WS 구현, 저장 경로 |

### 외부 공유 학습의 후속 조건

nco/nova-ax 연동은 이번 이식의 필수 범위가 아니다. 후속 제안은 다음
조건을 모두 충족할 때만 검토한다.

- 사용자가 명시적으로 opt-in한다.
- nova-use 로컬 실행은 외부 서비스 장애와 무관하게 동작한다.
- domain과 selector/frame은 정규화·해시되고 원문 입력, 이메일, API key,
  cookie, 페이지 본문은 전송하지 않는다.
- export 실패는 action 실패로 취급하지 않는다.
- 삭제/보존 기간 및 사용자별 격리 계약이 별도 승인된다.

## 6. 구현 순서와 게이트

| 순서 | 산출물 | 통과 조건 |
|---:|---|---|
| 0 | 복구·권리 준비 | fresh checkpoint와 격리 nova-use worktree는 PASS; dirty 핵심 파일 소유자/hunk 조정, 원본 사용 권리 확인 |
| 1 | P1 IPC/순수 분석 | login/search/form/quiz/checkout fixture에서 comprehension/affordance/playbook 실제 값, destructive fixture 보수 판정 |
| 2 | P2 local store/guard | 500건 cap, 원자 저장, 마스킹, 성공 recall, 동일 signature 반복 실패 차단, signature 변경 시 정상 재시도 |
| 3 | P3 effect ladder | 각 DOM rung, observer 해제, timeout, stale target, CDP escalation 및 policy block receipt 테스트 |
| 4 | P4 autostart/consent | safe action만 autostart, destructive/uncertain은 중지, autoApprove 및 remembered consent가 fresh destructive consent를 우회하지 못함 |
| 5 | 통합·A/B | 기존 Node A/B 원시 행을 유지하고 Electron/WebContents·disk persistence·consent를 포함해 재측정; 기능/legacy/error gate 유지, >20% latency/RSS 경고는 해소하거나 제품 예산으로 명시 승인 |
| 6 | T1 | nova-use `npm run build`, `npm test` 전체 통과와 P1~P4 집중 테스트 로그; 기존 실패가 있으면 별도 분류하고 녹색으로 오인 금지 |

현재 같은 프로토콜의 Node baseline과 후보 측정은 존재하며 >20%
latency/RSS 경고 규칙 중 latency가 발동했다. 다만 이 결과는
WebContents, CDP, 렌더링, 네트워크, disk persistence, consent를 포함하지
않는다. 구현 전후 Electron A/B에는 같은 fixture·반복·원시행 보존을
적용하고, 기능 100%, legacy parity 100%, runtime error 0을 하드 게이트로
유지한다. 제품 성능 예산은 측정 전에 고정하며 그 전에는 기능 성공률
외 성능 개선을 승인 근거로 쓰지 않는다.

## 7. 보류·거부 목록

- 보류: 성능 향상, 처리량 증가, 메모리 감소에 대한 모든 주장
- 보류: nco/mem0 또는 nova-ax로의 cross-app learning export
- 보류: 공용 npm/package workspace 추출
- 보류: P2/P4 활성화 — app-local store, fresh destructive consent, permission handler 검증 전
- 보류: 외부 배포 — lockfile/SBOM/CVE와 cli-extensions 소유권/라이선스 확인 전
- 거부: chrome.* 코드나 content script의 직접 복사
- 거부: Playwright/BrowserGym을 nova-use 런타임 드라이버로 도입
- 거부: 새 ref, deepInspect, capture, PolicyEngine, CDP dispatcher 구현
- 거부: nco/nova-ax DB migration 또는 nova-use의 신규 SQL DB
- 거부: 모델 프롬프트나 `safeToAutostart`만으로 destructive action 승인

## 8. 검증 영수증

| 변경 | 검증방법 | 등급 | Gap | 미검증항목 |
|---|---|---|---|---|
| 06단계 전략 보고서 작성·교정 | 지정 스펙, 실제 원본/대상 코드, 02/03/04/05 산출물을 직접 읽고 경로·symbol을 대조 | Evidence Tier 1 | 이 단계는 설계 결정이며 제품 코드 변경 없음 | P1~P4 제품 런타임 동작 |
| 옵션 비교 및 공통화 경계 | 다섯 선택지를 P1~P4별 기존 seam과 대조하고 프로젝트별 소유 책임 분리 | Evidence Tier 1 | 공용 계약은 제안 상태 | 두 번째 실제 consumer 호환성 |
| 복구 판정 | fresh checkpoint SHA, 설정 backup SHA, 격리 worktree 경로가 기록된 03 보고서 직접 확인 | Evidence Tier 1 | main dirty churn 지속 | 구현 직전 checkpoint 재대조 |
| 격리 A/B | `ab-summary.md`, `raw.jsonl`, `environment.json`과 재현 명령 대조 | Evidence Tier 1 | synthetic Node prototype | Electron/WebContents 제품 A/B |
| 성능 판정 | 같은 프로토콜 baseline/candidate 7회×40,000 ops 결과 대조 | Evidence Tier 1 | latency +238.90% alert | 실제 UI task latency/CPU/RSS |
| 안전 결정 | PolicyEngine 기본값, ConsentBroker autoApprove/remembered 흐름, 02 findings 직접 확인 | Evidence Tier 1 | P2/P4 activation blocker | Electron E2E에서의 실제 우회 방지 |
| 기준선 회귀 | v5 로그에서 nco build 3/3, nova-use build 3/3, focused 4 files/44 tests 3/3 확인 | Evidence Tier 1 | 전체 nova-use suite RED | 회사 T1 full build+test |
| 자동 검증 기준 | nco `npm run build` → `tsc`, exit 0 | Evidence Tier 1 | 없음 | nova-use 제품 소스는 이 단계에서 미변경 |
| 격리 계약 재검증 | `node --test prototypes/browser-control-port/adapter.test.mjs` | Evidence Tier 1 | 5/5 PASS | Electron/WebContents 제품 통합 |
| nco 관련 회귀 | `npm run test:run -- tests/trajectory-guard.test.ts tests/response-quality.test.ts` | Evidence Tier 1 | 2 files/16 tests PASS | nco 전체 suite는 이 단계에서 재실행하지 않음 |
| 제출 형식 | 첫 줄 `done: [Evidence Tier 1]` 및 실제 response-quality checker 실행 | Evidence Tier 1 | 없음 | 없음 |

## 9. 변경 파일 목록과 핵심 diff

변경 파일:

- `REPORTS/technology-porting/browser-control-extension-port-improvement-debate-2026-07-23.md` (근거·판정 교정)
- `data/team-runner/team_tech-port-06-improvement-debate-2026-07-23.md` (품질 게이트용 요약 교정)

핵심 diff:

- 직접 이식, 래퍼/어댑터, 부분 포팅, 자체 재구현, 보류/거부를 실제
  P1~P4 seam 기준으로 비교했다.
- `CONDITIONAL_GO_NATIVE_PARTIAL_PORT_WITH_THIN_ADAPTERS` 결정을 내리고,
  단계별 구현·금지선·선행 게이트를 고정했다.
- nova-use/nco/nova-ax의 공통 계약 후보와 런타임별 고유 책임을 분리했다.
- 03 복구 `READY`, 05 격리 기능/호환 PASS와 microperformance alert,
  04 전체 T1 RED를 함께 반영해 구현·활성화·배포 판정을 분리했다.
- 검증되지 않은 제품 성능 개선 주장을 차단하고 Electron 통합 A/B
  acceptance gate를 명시했다.

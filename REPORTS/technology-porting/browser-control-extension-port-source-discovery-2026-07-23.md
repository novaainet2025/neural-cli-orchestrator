done: [Evidence Tier 1] Stage 01 기술 탐색·습득 완료. 회사 전체 T1 gate는 미충족이며 상세 Gap을 아래에 기록했다.

# cli-extensions → nova-use 브라우저 제어 이식: 기술 탐색·습득 dossier

- 검증일: 2026-07-23 (Asia/Seoul)
- 회사 목표: `cli-extensions`의 P1~P4 브라우저 제어 능력을 `nova-use` Electron `WebContents`에 적응
- 하위작업: 01 기술 탐색·습득팀
- 상태: `RESEARCH_COMPLETE`
- 구현 판단: `GO_NATIVE_INCREMENTAL_WITH_GATES`
- T1 상태: `FAIL` — 2026-07-23 19:29~19:31 KST 재검증에서 대상 기능 회귀 테스트·전체 타입체크와 nco 빌드는 통과했지만, nova-use와 nco의 전체 테스트 suite는 녹색이 아니다.

## 0. 결론

P1~P4는 새 브라우저 자동화 프레임워크를 도입하지 않고, `nova-use`의 기존 `WebContents`/CDP/안전 게이트 위에 얇은 기능 계층으로 이식하는 것이 가장 작은 변경이다.

1. P1은 기존 snapshot의 안정 ref를 입력으로 결정론적 comprehension/affordance/playbook을 계산한다. 현재 ref가 제공하지 않는 정보만 고정된 분석 함수를 통해 수집한다.
2. P2는 `app.getPath("userData")` 아래에 앱 전용, 500건 제한, 원자적 JSON 저장소를 둔다. `nco`와 `nova-ax`의 메모리 구현은 참조 후보이지 런타임 의존성이 아니다.
3. P3는 대상 요소에 한정한 `MutationObserver` 검증 결과를 순수 JSON으로 돌려받고, 실패할 때만 기존 CDP 실행 경로와 allowlist/PolicyEngine을 사용한다.
4. P4의 destructive 판정은 모델 프롬프트가 아니라 실행 직전 정책·동의 경계에서 강제한다. `safeToAutostart`는 힌트이며 보안 결정 자체가 아니다.

원본 저장소에는 배포 가능한 라이선스 파일이나 package license 선언이 없다. 따라서 코드를 복사하지 않는다는 제품 제약과 별개로, 외부 배포 전 소유권·라이선스 확인이 필요하다. 이 문서는 능력·동작 접점만 분석하며 원본 코드를 대상에 복사하지 않았다.

## 1. 증거 규칙과 범위

- 로컬 상태는 Git HEAD와 별도로 파일 SHA-256을 기록했다. 네 작업트리 모두 공유 변경이 있어 commit SHA만으로 현재 파일 내용을 재현할 수 없기 때문이다.
- 공식 출처가 없는 내부 저장소에는 공개 URL을 만들거나 추정하지 않았다.
- 버전은 lockfile·package metadata·공식 릴리스로 교차 확인했다. Electron 바이너리 직접 실행은 샌드박스에서 `SIGABRT`였으므로 실행 결과로 검증했다고 주장하지 않는다.
- 벤치마크 수치는 공식 논문/저장소가 공개한 데이터셋 규모다. 이 작업에서 nova-use의 WebArena/Mind2Web/OSWorld 점수를 측정하지 않았다.
- 대상 소스 코드는 수정하지 않았다. 이 하위작업의 변경은 조사 문서뿐이다.

## 2. 현재 구조와 고정점

| 프로젝트 | 로컬 HEAD | 공개 원격/검증 | 현재 접점 | 판단 |
|---|---|---|---|---|
| nova-use | `408718d1739bcea747c3c863f75da5ac5a600446` | configured Git remote 없음 | `src/main/agent-browser-adapter.ts`, `browser.ts`, `browser-consent.ts`, `policy.ts`, `agent-control.ts`, `src/shared/ipc.ts` | P1~P4의 유일한 런타임 대상. 기존 ref/FORCE/CDP/deepInspect/capture/PolicyEngine을 확장하고 재구현하지 않는다. |
| nco | `4adf31725bad1f44220d04952151c8197469f6e1` | local `origin`은 [novaainet2025/neural-cli-orchestrator](https://github.com/novaainet2025/neural-cli-orchestrator). 현재 샌드박스 DNS 제한으로 원격 HEAD 미검증 | `src/core/reflexion.ts`, `mem0-bridge.ts`, `sleep-consolidator.ts`, `shared-state.ts` | 회고·공유 메모리 패턴 참고. nova-use P2의 직접 의존성으로 연결하면 서비스 가용성·개인정보 경계가 커지므로 제외. |
| nova-ax | `7644131db39062ffad62f0a1a61cf55c32bc9ab1` | local `origin`은 [novaainet2025/nova-ax](https://github.com/novaainet2025/nova-ax). 현재 샌드박스 DNS 제한으로 원격 HEAD 미검증 | `src/core/memory-system.ts`, `src/index.ts`의 memory store/recall API | SQLite/FTS·embedding recall의 향후 후보. 500건 앱 로컬 기억에는 과대하며 브라우저 런타임 의존성으로 두지 않는다. |
| cli-extensions | `cff682d60e1e0579d0bc0bb32088ed2cef313b00` | configured Git remote 없음 | `extension/src/content/page-digest.ts`, `force.ts`, `shared/destructive.ts`, `local-bridge/src/shared-learning.js`, `repeat-guard.js` | 요구사항과 테스트 oracle로만 사용. Chrome extension API와 코드를 Electron에 복사하지 않는다. |

추가 관찰:

- nova-use `package.json` 버전은 `0.0.1`, cli-extensions의 각 package 버전은 `0.1.0`이다.
- 네 저장소에서 로컬 Git tag는 발견되지 않았다.
- 네 저장소 모두 최상위 `LICENSE`, `NOTICE`, `SECURITY` 파일이 발견되지 않았다.
- nova-use `package.json`만 `MIT`를 선언한다. nco, nova-ax, cli-extensions package metadata에는 license 선언이 없다.

## 3. P1~P4 코드 접점

| 단계 | 원본에서 확인한 능력 | nova-use의 기존 기반 | 실제 gap | 최소 구현 접점 | 재구현 금지선 |
|---|---|---|---|---|---|
| P1 심층 이해 | page purpose, login/checkout/search 신호, affordance, playbook, `autoMission`, `safeToAutostart` | `agent-browser-adapter.ts`의 `pageDigestFromSnapshot`; `browser.ts`의 stable ref/snapshot/deepInspect/preflight | 현재 digest는 form/input/button/link 수와 얕은 목적·진척·다음 행동 정도만 제공한다. shared IPC 타입도 같은 수준이다. | snapshot ref에서 결정론적으로 comprehension/affordance를 파생하고 IPC 타입을 확장한다. ref에 없는 최소 신호만 고정된 page-world/isolated-world 수집 함수로 보완한다. | ref 생성, deepInspect, preflight, capture를 별도 구현하지 않는다. |
| P2 공유 학습 | 500건 제한, 민감정보·이메일 마스킹, recall, lesson/done, 반복 실패 차단 | adapter의 단일 실행 경계; Electron `userData`; nco reflexion과 nova-ax memory는 참고 구현 | 브라우저 작업 전용 recall·기록·실패 guard가 없다. | `userData/browser-learning` 아래 권한 제한 파일, temp-write+rename, bounded record, page signature/action fingerprint를 추가하고 adapter 실행 전후에 연결한다. | nco/mem0/nova-ax 서비스를 필수 의존성으로 만들거나 원문 DOM/비밀값을 저장하지 않는다. |
| P3 FORCE 검증 ladder | target-scoped `MutationObserver`, DOM effect 확인, 단계별 escalation | `browser.ts`의 WebContents, CDP debugger `1.3`, 기존 allowlist·PolicyEngine; FORCE action entry point | FORCE_CLICK/FORCE_TYPE이 현재 일반 click/input으로 낮아지며 target-specific effect 검증과 escalation receipt가 없다. | 고정된 검증 함수를 직렬화해 target ref에 실행하고 관찰 결과를 JSON으로 반환한다. timeout/finally에서 observer를 해제한다. 실패 시 기존 CDP 함수로만 escalate한다. | 임의 `Runtime.evaluate`, 새 CDP dispatcher, 직접 debugger 우회, 별도 ref 시스템을 만들지 않는다. |
| P4 자율 착수·파괴 게이트 | destructive classifier, non-destructive autostart | `policy.ts`, `browser-consent.ts`, `agent-control.ts`, preflight token | `safeToAutostart`와 destructive 판정을 실행 경계에서 강제하는 통합 규칙이 없다. | classifier를 shared contract로 두고 실행 직전 policy/consent에 연결한다. 불명확한 submit/purchase/delete는 동의 필요로 보수 처리한다. | 프롬프트만으로 보호하거나 기존 consent/PolicyEngine을 건너뛰지 않는다. |

### 구조별 세부 관찰

- `nova-use/src/main/agent-browser-adapter.ts`: snapshot, deep inspection, preflight, action dispatch가 이미 한 경로에 모여 있다. P1 digest와 P2 recall/guard, P3 receipt를 연결하기 가장 작은 seam이다.
- `nova-use/src/main/browser.ts`: `webContents.debugger.attach("1.3")`, CDP command 전송, snapshot/deepInspect, `executeJavaScript` 경로가 이미 있다. 새 브라우저 드라이버를 도입할 근거가 없다.
- `nova-use/src/main/browser-consent.ts`, `policy.ts`, `agent-control.ts`: destructive/autostart 강제는 이 경계를 통과해야 한다.
- `nco/src/core/reflexion.ts`: recall 후 회고를 저장하는 순서는 유용하지만 mem0 서비스 결합은 브라우저 앱 격리에 맞지 않는다.
- `nova-ax/src/core/memory-system.ts`: 검색 규모가 커질 때 FTS/embedding 후보가 될 수 있으나, 현재 500건 제한 요구에는 JSON 선형 검색이 단순하고 재현 가능하다.

## 4. 후보 기술 검증표

| 후보 | 확인 버전/commit | 공식 출처 | 릴리스·보안·라이선스 | 적용 결정 | 대안 |
|---|---|---|---|---|---|
| Electron WebContents | 설치 lockfile `43.2.0`; tag commit `9b58e96340a34cccaccc08e410e76838b50b0cb2`; Chromium `150.0.7871.129` | [WebContents](https://www.electronjs.org/docs/latest/api/web-contents/), [43.2.0 release](https://github.com/electron/electron/releases/tag/v43.2.0) | [Security checklist](https://www.electronjs.org/docs/latest/tutorial/security), [MIT license](https://github.com/electron/electron/blob/main/LICENSE) | 채택. 현재 nova-use 기반을 유지한다. `executeJavaScript` 입력은 정적 함수/검증된 데이터로 제한한다. | isolated world 실행은 page-world 충돌이 확인될 때 우선 검토. 외부 browser driver는 제외. |
| Electron Debugger + CDP | nova-use attach protocol `1.3`; devtools-protocol 확인 commit `a9544e3797c9dc815c0f0d0c360d9e5954191aee` | [Electron Debugger](https://www.electronjs.org/docs/latest/api/debugger/), [CDP protocol](https://chromedevtools.github.io/devtools-protocol/), [DOM domain](https://chromedevtools.github.io/devtools-protocol/tot/DOM/), [Input domain](https://chromedevtools.github.io/devtools-protocol/tot/Input/) | tip-of-tree는 변경 가능; stable protocol `1.3` 유지. [BSD-3-Clause license](https://github.com/ChromeDevTools/devtools-protocol/blob/master/LICENSE) | P3 최종 escalation에만 사용. 기존 allowlist와 policy 경로를 통과한다. | DOM 기반 검증 성공 시 CDP를 호출하지 않는다. |
| DOM `MutationObserver` | WHATWG Living Standard, 고정 release/SHA 없음 | [DOM Standard](https://dom.spec.whatwg.org/) | 웹 표준 API; 별도 라이브러리 불필요 | 채택. target과 연관된 attribute/child/text 변화만 관찰하고 timeout/finally에서 disconnect한다. | event/polling은 누락·부하가 커 fallback으로만 고려. |
| Electron `app.getPath("userData")` + Node fs | Electron 43.2.0; Node 실행환경 `25.9.0` | [Electron app paths](https://www.electronjs.org/docs/latest/api/app), [Node 25.9 fs](https://nodejs.org/download/release/v25.9.0/docs/api/fs.html) | Electron MIT; OS 파일 권한과 원자적 rename 필요 | P2 로컬 저장소에 채택. 신규 런타임 dependency 없음. | `better-sqlite3`는 native packaging·마이그레이션 비용 때문에 500건 요구에는 제외. |
| nco mem0/reflexion | local HEAD `4adf31725bad1f44220d04952151c8197469f6e1` | [official configured repository](https://github.com/novaainet2025/neural-cli-orchestrator) | 저장소 최상위 license/security 파일과 package license 선언이 확인되지 않음 | 패턴 참고만. nova-use 브라우저 런타임 의존성으로 제외. | 나중에 명시적 opt-in과 redacted summary export가 생기면 비동기 공유 후보. |
| nova-ax SQLite/FTS memory | local HEAD `7644131db39062ffad62f0a1a61cf55c32bc9ab1` | [official configured repository](https://github.com/novaainet2025/nova-ax) | 저장소 최상위 license/security 파일과 package license 선언이 확인되지 않음 | 규모 확장 후보만 유지. P2 기본 구현에서는 제외. | 로컬 bounded JSON; 데이터가 수천 건 이상으로 커질 때 SQLite 재평가. |
| TypeScript | lockfile `5.9.3` | [TypeScript repository](https://github.com/microsoft/TypeScript) | Apache-2.0 | 기존 타입/IPC contract 확장에 사용 | 없음. |
| Vitest | lockfile `3.2.7` | [Vitest repository](https://github.com/vitest-dev/vitest) | MIT | P1~P4 단위·회귀·receipt 테스트에 사용 | Electron E2E는 별도 계층에서 Playwright 검토. |

설치 버전은 lockfile의 `43.2.0`과 해당 release tag commit으로 고정한다. 변동하는 upstream `main` HEAD는 구현 재현 기준으로 사용하지 않는다.

## 5. 논문·재현 가능한 벤치마크

| 벤치마크 | 논문/공식 저장소 | 확인 commit | 재현 범위 | 이 프로젝트에서의 쓰임 | 한계/대안 |
|---|---|---|---|---|---|
| WebArena | [ICLR 2024 paper](https://proceedings.iclr.cc/paper_files/paper/2024/hash/4410c0711e9154a7a2d26f9b3816d1ef-Abstract-Conference.html), [repository](https://github.com/web-arena-x/webarena), [v0.2.0 release](https://github.com/web-arena-x/webarena/releases/tag/v0.2.0) | `e32b71e3f5b2463bb102457591bc06c0f2c93acf` | 812개 self-hosted 웹 작업, programmatic functional correctness | P1 playbook/P4 전체 임무 성공률을 측정하는 후속 E2E 후보 | 환경 구축 비용이 크다. T1 단위 테스트 대체물이 아니다. |

이 조사에서는 위 benchmark를 실행하지 않았다. 따라서 후보 기술 선정 근거로만 쓰며 성능 점수나 개선률을 주장하지 않는다.

## 6. 보안·라이선스 게이트

### 보안

1. Electron security checklist에 맞춰 원격 콘텐츠에 Node integration을 허용하지 않고 context isolation/sandbox와 IPC sender 검증을 유지해야 한다.
2. P1/P3의 DOM 함수는 사용자가 만든 코드나 모델 출력 문자열을 그대로 평가해서는 안 된다. 구현에 포함된 정적 함수와 검증된 ref/primitive만 전달한다.
3. `MutationObserver`는 대상과 관련된 변화만 수집하고, 성공·오류·timeout 모든 경로에서 해제한다.
4. P2에는 raw page text, password, token, cookie, 이메일을 저장하지 않는다. action은 selector/ref의 제한된 fingerprint와 text length 위주로 기록하고 page signature 변경이나 성공 시 반복 실패 상태를 초기화한다.
5. P2 파일은 가능한 플랫폼에서 사용자 전용 권한으로 만들고, 임시 파일에 쓴 뒤 rename한다. 최대 500건을 강제한다.
6. P3의 CDP escalation은 현재 debugger 소유권, protocol `1.3`, command allowlist, PolicyEngine을 모두 유지한다.
7. P4 destructive 판정이 확실하지 않으면 submit/purchase/delete/permission 변경을 동의 필요로 올린다. 프롬프트의 `safeToAutostart`만 믿지 않는다.

### 라이선스

- Electron은 MIT, devtools-protocol은 BSD-3-Clause, TypeScript는 Apache-2.0, Vitest는 MIT로 공식 저장소에서 확인했다.
- nova-use는 package metadata에 MIT가 있으나 저장소 최상위 LICENSE 파일이 없다.
- nco, nova-ax, cli-extensions는 최상위 license 파일과 package license 선언이 확인되지 않았다.
- 특히 cli-extensions의 코드를 외부 배포물에 복사·파생하는 권한은 이 조사로 확인되지 않는다. 제품 스펙의 “복붙 금지”를 기술 설계와 라이선스 안전 양쪽에서 유지해야 한다.
- 외부 배포 전 법적 소유권과 notice 의무를 별도 확인하는 것을 release blocker로 둔다.

## 7. 구현 handoff

1. P1: `src/shared/ipc.ts` contract와 `src/main/agent-browser-adapter.ts`의 digest 계산만 확장하고 fixture 기반 결정론 테스트를 먼저 추가한다.
2. P2: 브라우저 전용 learning store/repeat guard를 새 main-process 모듈로 분리하고 adapter의 execute 전후에 연결한다. 신규 npm dependency는 추가하지 않는다.
3. P3: target-effect receipt 타입과 DOM 검증 ladder를 추가한 뒤 기존 CDP 함수로 escalation을 연결한다. 각 rung과 정책 차단을 테스트한다.
4. P4: destructive 분류를 shared contract로 만들고 policy/consent 실행 경계에서 autostart를 강제한다. 안전/불명확/파괴 fixture를 모두 둔다.
5. 각 단계에서 build, typecheck, 전체 테스트, 브라우저 기능 집중 테스트 결과를 검증 영수증으로 저장한다.

권장하지 않는 선택:

- Playwright/BrowserGym을 nova-use 런타임 브라우저 드라이버로 추가
- CDP DOMSnapshot/Accessibility tree를 기본 comprehension으로 새로 구축
- nco/mem0 또는 nova-ax 서버를 P2 필수 서비스로 연결
- `better-sqlite3`를 500건 bounded store에 도입
- 모델 프롬프트만으로 destructive action을 막음
- 임의 문자열을 `executeJavaScript`/`Runtime.evaluate`로 실행

## 8. 검증 영수증

### 원본 cli-extensions oracle

실행 경로: `/Users/nova-ai/project/크롬확장프로그램/cli-extensions`

```text
node tests/shared-learning.mjs
shared learning: ok

node tests/repeat-guard.mjs
repeat guard: ok

node tests/performance-contract.mjs
performance contract: ok

node tests/nco-client-performance.mjs
nco client performance: ok
```

### nova-use 집중 회귀와 타입체크

아래 PASS는 이 문서의 파일 해시를 기록한 조사 스냅샷 결과다.

실행 경로: `/Users/nova-ai/project/nova-use`

```text
npm test -- --configLoader runner \
  tests/agent-browser-adapter.spec.ts \
  tests/browser.spec.ts \
  tests/agent-control.spec.ts \
  tests/browser-consent.spec.ts

Test Files  4 passed (4)
Tests       44 passed (44)
Duration    418ms
wall clock  1.20s
```

```text
npm run typecheck
PASS
wall clock 3.41s
```

공유 작업트리가 이후 변경되어 2026-07-23 19:31 KST에 같은 검증을 다시 실행했다. nova-use 브라우저 제어 핵심 파일의 위 SHA-256은 변하지 않았고 집중 테스트와 전체 타입체크가 모두 통과했다. 19:21 KST 실행에서 일시적으로 관찰된 `ObsidianView.tsx:956`의 TS6133은 최신 실행에는 재현되지 않았으므로 현재 오류로 보고하지 않는다.

```text
npm test -- --config /Users/nova-ai/project/nco/.tmp-nova-use-vitest.config.mts \
  tests/agent-browser-adapter.spec.ts \
  tests/browser.spec.ts \
  tests/browser-consent.spec.ts \
  tests/agent-control.spec.ts

Test Files  4 passed (4)
Tests       44 passed (44)
Duration    764ms

npm run typecheck
PASS — TypeScript 오류 0
```

Stage 01은 제품 소스를 수정하지 않았다. 타입체크는 현재 PASS지만 전체 suite 실패가 남아 있으므로 T1을 PASS로 주장하지 않는다.

### nova-use build

직접 빌드는 소스 오류가 아니라 공유 경로의 임시 config 쓰기 제한에서 멈췄다.

```text
npm run build
EPERM: operation not permitted, open
/Users/nova-ai/project/nova-use/electron.vite.config.<timestamp>.mjs
```

동일 파일 상태에서 writable `/tmp` root와 outDir을 사용하고 같은 `node_modules`를 연결한 격리 빌드는 19:26 KST 재실행에서도 통과했다.

```text
npm run build
main:     137 modules transformed
preload:  1 module transformed
renderer: 4716 modules transformed
PASS
main 781ms / preload 12ms / renderer 11.61s
wall clock 12.96s
```

기존 dynamic/static import warning과 outDir 위치 경고만 있었고 build error는 없었다. 검증 파일과 출력은 `/tmp/nova-use-stage01-*` 아래에만 생성되어 제품 저장소를 변경하지 않았다.

### nova-use 전체 테스트

직접 기본 config loader는 `node_modules/.vite-temp` 쓰기 제한으로 시작하지 못했다. writable config를 사용해 19:24 KST에 실행한 최신 실제 결과:

```text
Test Files  8 failed | 42 passed (50)
Tests       11 failed | 452 passed | 11 skipped (474)
Errors      1 unhandled rejection
Duration    11.97s
```

실패 분류:

- 샌드박스/권한 근거가 명확한 실패: filetree fixture mkdir suite, Git ref/worktree/home 경로 4건, nested `sandbox-exec` 1건, loopback bind 3건.
- 실제 baseline 불일치: nova CLI command inventory가 기대 `229/27`, 실제 `226/24`.
- 추가 미분류 실패: automation 계산 test의 5초 timeout 1건, PC-control lock test의 proxy-response timeout 1건과 그에 따른 unhandled rejection. 환경 탓으로 단정하지 않았다.
- 이 하위작업은 문서만 변경했으므로 위 기존 실패를 수정하지 않았다.

### nco 검증

실행 경로: `/Users/nova-ai/project/nco`

```text
npm run build
tsc
PASS
```

전체 테스트 재검증:

```text
npm test -- --run
Test Files  2 failed | 85 passed (87)
Tests       2 failed | 411 passed (413)
```

기존 실패는 `tests/근거.test.ts`의 고정 기대일 `2026-07-14` 대 현재 포인터 `2026-07-23`, `src/core/smart-router.test.ts`의 기대 provider cost order 불일치다. Stage 01 문서 범위 밖이므로 수정하지 않았다.

### 제출 형식 게이트

빌드된 실제 `dist/verification/response-quality.js`의 `checkResponseQuality(..., { requireProtocolPrefix: true })`로 두 산출물을 검사했다.

```text
REPORTS/.../browser-control-extension-port-source-discovery-2026-07-23.md
{"pass":true,"heuristics":[]}

data/team-runner/team_tech-port-01-source-discovery-2026-07-23.md
{"pass":true,"heuristics":[]}
```

## 9. 파일 해시 증거

공유 작업트리의 조사 시점 내용:

| 프로젝트 | 파일 | SHA-256 |
|---|---|---|
| nova-use | `package.json` | `52acea9a8cddff98787b0dec6226a38c349afd282372deeea162c36be0d3e01f` |
| nova-use | `package-lock.json` | `e737778a351c3e85b23ab375729af763585eb0d34c4911a170ed339cbe6f029d` |
| nova-use | `src/main/agent-browser-adapter.ts` | `b5f7fe0871a213196ba96cf16ab8dd06299b2c7bf5b6fb039d151048fb706779` |
| nova-use | `src/main/browser.ts` | `dffe65023fab56908e11ed11b6fea677997705f0821ee1876ac3221582c83f92` |
| nova-use | `src/main/browser-consent.ts` | `dafe32b70b5dac42f6ff2ead2c964f9457131967b5e0458a7c339dcac0aeb4eb` |
| nova-use | `src/main/policy.ts` | `e9b715e335939ca217a9dbc84160abd269f808452c569e809d8eb2e6e98a908e` |
| nova-use | `src/main/agent-control.ts` | `e1a3841e4acd73f005f15382ba188ac93650f80e6a461017f14398878ea24797` |
| nova-use | `src/shared/ipc.ts` | `5d5d526b1b220bcd8f28137fb2f9db0901836ddb43cc944c38b0e987c66f51fd` |
| nco | `src/core/reflexion.ts` | `795dece97e5b4e7ee61f184665dd26afcc80f9041349ab447265708a8eab10e2` |
| nco | `src/core/mem0-bridge.ts` | `192a6b4276f3649f082ff60950b53f6cd4e865f57a4d7020db3ffcaf8ca6104a` |
| nco | `src/core/sleep-consolidator.ts` | `9da0d10355856f298e244e06dbd5ca05e5e605f1f474c2c0ef4d1f97b6196f21` |
| nco | `src/core/shared-state.ts` | `f939feac59d417c255c0cc69d8f6b66e91a6cb7776ac3c36ed2d6d570baf424f` |
| nova-ax | `src/core/memory-system.ts` | `91a0009179965046001570309cf0f8f0fc18cd3f97d12a9da6a6fb43d76efb75` |
| nova-ax | `src/index.ts` | `c4826ea384a90278b64376797c59d708d7dd57871ad9959affa84c90e18cb59d` |
| cli-extensions | `extension/src/content/page-digest.ts` | `4348367b3947e156bf04a5091da50096acc737647a473d82cb4f81f42100291e` |
| cli-extensions | `extension/src/content/force.ts` | `8ab79ccc83c1fc5fff19b502a47e88d8462dea0412ad1e7817e2f40d80207741` |
| cli-extensions | `extension/src/shared/destructive.ts` | `01c11ed2a473a8f63c1fb2ca423fc364e2be40452fca83700c019d8ae2a89e43` |
| cli-extensions | `local-bridge/src/shared-learning.js` | `039fe80cc9656b0fd14ec4a3711e7d18823f2a796f5eff2e9c932d60a0ce7bbc` |
| cli-extensions | `local-bridge/src/repeat-guard.js` | `6b274939d334376f02b02ed451cff1cca3923a0d0ee3fe85035d5b043f1cdc50` |

`extension/src/content/force.ts`는 동시 작업으로 이전 조사 해시에서 변경되었다. 위 값은 19:30 KST의 최신 worktree 해시이며, 이 Stage 01 작업은 해당 원본 소스를 수정하지 않았다. 변경 후 원본 TypeScript 검사와 repeat/shared-learning/integration/performance 계약 테스트는 19:31 KST에 다시 통과했다.

## 10. 미검증·후속 gate

- nova-use와 cli-extensions에는 configured Git remote가 없어 공식 공개 repo URL과 원격 최신 상태를 검증하지 못했다.
- 네 저장소의 license/security 정책 부재는 repository owner/legal 확인이 필요하다.
- Electron 43.2.0 binary 직접 실행 버전 출력은 현 샌드박스에서 `SIGABRT`여서 lockfile·package metadata·공식 release로만 확인했다.
- OSWorld commit은 이번 조사에서 고정하지 않았다.
- WebArena/Mind2Web/BrowserGym/OSWorld를 nova-use로 실행하지 않았다.
- nova-use 전체 타입체크와 격리 빌드는 현재 통과하지만, 전체 T1은 CLI inventory 불일치, 명확한 샌드박스 제약, 원인이 확정되지 않은 automation/PC-control timeout 때문에 녹색이 아니다. 구현 완료를 주장하려면 동일 commit/파일 해시 기준으로 전체 build+typecheck+test가 허용된 환경에서 통과해야 한다.
- P1~P4 구현 자체는 이 01 기술 탐색·습득 하위작업의 범위가 아니며 아직 수행하지 않았다.

## 11. 변경 파일 목록과 핵심 diff 요약

변경 파일:

- `REPORTS/technology-porting/browser-control-extension-port-source-discovery-2026-07-23.md`
- `data/team-runner/team_tech-port-01-source-discovery-2026-07-23.md`

핵심 diff:

- 응답/산출물 첫 줄을 품질 게이트가 요구하는 `done:` 프로토콜 접두사로 교정했다.
- 로컬 Git remote 설정과 원격 HEAD 검증을 구분하고, DNS 제한으로 확인하지 못한 원격 일치 주장을 제거했다.
- 재현 기준을 변동하는 upstream `main`이 아니라 설치 Electron `43.2.0` 및 release tag로 고정했다.
- 실행 가능한 benchmark 후보를 공식 ICLR 논문과 WebArena `v0.2.0` release commit으로 한정했다.
- P1~P4 구현 완료와 회사 전체 T1 통과를 주장하지 않고, Stage 01 완료와 미검증 항목을 분리했다.
- 동시 작업으로 변경된 원본 `force.ts` 해시와 최신 원본 계약 검사 결과를 갱신했다.
- nco 전체 suite 영수증을 최신 `85 files / 411 tests PASS, 2 files / 2 tests FAIL`로 교정했다.
- 실제 `checkResponseQuality`로 두 산출물 모두 `FORMAT_MISMATCH` 없이 통과함을 확인했다.

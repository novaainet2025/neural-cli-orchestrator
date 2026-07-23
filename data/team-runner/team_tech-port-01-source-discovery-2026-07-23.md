done: [Evidence Tier 1] Stage 01 기술 탐색·습득 완료. 회사 전체 T1 gate는 미충족이며 상세 Gap을 아래에 기록했다.

# 01 기술 탐색·습득팀 — 브라우저 제어 이식 근거 보고서

> taskId: `task_zniMQDCD4SK65frt`  
> 팀: `team_tech-port-01-source-discovery`  
> 검증일: 2026-07-23 (KST)  
> 상태: `Stage 01 done: [Evidence Tier 1]`; 회사 전체 T1 gate는 아래 full test 실패로 `NOT SATISFIED`  
> 단계 결론: `PORT_RESEARCH_DECISION: PROCEED_TO_DESIGN_WITH_EXISTING_ELECTRON_PRIMITIVES`

## 1. 범위와 판정

이 문서는 `/Users/nova-ai/project/nova-use/docs/plans/browser-control-extension-port.md`를 먼저 읽고 수행한 **Stage 01 기술 탐색·습득 산출물**이다. P1~P4 구현 완료 보고서가 아니다. 다음 단계는 아래 근거를 입력으로 설계·구현·독립 검증을 수행해야 한다.

핵심 판정은 다음과 같다.

- Chrome 확장의 `chrome.debugger`/content script 구조를 그대로 복사하지 않는다. `nova-use`의 기존 `WebContents`, `webContents.debugger`, IPC, ref, FORCE, CDP allowlist, `deepInspect`, capture, `PolicyEngine`, consent 경계를 확장한다.
- P1~P4 런타임의 소유자는 `nova-use` main process다. `nco`는 단계 오케스트레이션, `nova-ax`는 관측 UI이므로 브라우저 학습 저장소나 DOM 실행 코드를 두 프로젝트에 중복 구현하지 않는다.
- 외부 런타임 프레임워크를 새로 넣을 필요가 없다. Electron/Chromium의 공식 API와 현재 소스의 고정 경계를 재사용하는 안이 의존성·보안·패키징 위험이 가장 작다.
- 원본 확장과 대상 저장소 모두 dirty worktree다. 아래 commit SHA만으로 현재 조사 대상 파일을 재현할 수 없으므로, 핵심 파일은 SHA-256도 함께 기록했다.

### 이전 산출물 교정

직전 문서의 가공된 프로젝트별 GitHub 저장소, 임의 arXiv 번호와 benchmark 경로는 로컬 `git remote`, 파일, HTTP 원문으로 확인되지 않았다. 이 보고서에서는 해당 출처를 모두 제거했다. 확인되지 않은 공개 저장소·릴리스·논문을 프로젝트 근거로 만들지 않는다.

## 2. 조사 대상과 provenance

| 대상 | 로컬 버전 | 조사 시점 HEAD | 공식/원본 출처 | worktree | 라이선스 근거 |
|---|---:|---|---|---:|---|
| nova-use | `0.0.1` | `408718d1739bcea747c3c863f75da5ac5a600446` (2026-07-22) | git remote 없음. 로컬 경로가 유일한 1차 근거 | dirty 225건 | `package.json`은 MIT 선언. 루트 `LICENSE` 없음 → 배포 라이선스 증거는 불완전 |
| nco | `1.0.0` (`neural-cli-orchestrator`) | `4adf31725bad1f44220d04952151c8197469f6e1` (2026-07-21) | local `origin`: https://github.com/novaainet2025/neural-cli-orchestrator; DNS 제한으로 원격 HEAD 미검증 | dirty 541건 | 루트 `LICENSE`와 package license 필드 없음 → 미확인 |
| nova-ax | `0.1.0` | `7644131db39062ffad62f0a1a61cf55c32bc9ab1` (2026-07-07) | https://github.com/novaainet2025/nova-ax | dirty 7건 | 루트 `LICENSE`와 package license 필드 없음 → 미확인 |
| cli-extensions 원본 | components `0.1.0` | `cff682d60e1e0579d0bc0bb32088ed2cef313b00` (2026-07-23) | git remote 없음. 로컬 경로가 유일한 1차 근거 | dirty 63건 | 자체 루트 라이선스 없음. `THIRD_PARTY_NOTICES.md`는 제3자 코드 고지만 증명 |

런타임/도구 버전:

| 항목 | 확인 버전 | 해석 |
|---|---:|---|
| 로컬 Node / npm | `v25.9.0` / `11.12.1` | 조사 명령 실행 환경 |
| nova-use Electron | lock `43.2.0` (`package.json` `^43.1.1`) | 공식 v43.2.0 릴리스는 Chromium `150.0.7871.129`, Node `24.18.0` 포함 |
| nova-use TypeScript / Vitest / ws | `5.9.3` / `3.2.7` / `8.21.1` | 대상 타입·테스트 기준 |
| nco TypeScript / Vitest / ws / better-sqlite3 | `6.0.2` / `4.1.4` / `8.20.0` / `12.8.0` | 오케스트레이터 기준. 대상에 native SQLite를 추가할 근거가 아님 |
| nova-ax TypeScript / ws / better-sqlite3 | `5.9.3` / `8.20.1` / `12.10.0` | 관측 서비스 기준. 대상 프로필 저장소로 재사용하지 않음 |
| 원본 extension TypeScript / esbuild / Chrome types | `5.9.3` / `0.25.12` / `0.0.295` | Chrome 전용 구현을 Electron에 직접 복사할 수 없는 근거 |

버전과 dirty 건수는 각 로컬 저장소의 `package.json`/lockfile, `git rev-parse HEAD`, `git show -s --format=%cs`, `git remote get-url origin`, `git status --porcelain` 결과다. dirty 건수는 동시 작업 중인 공유 워크트리의 2026-07-23 조사 시점 스냅샷이므로 이후 변동할 수 있다.

## 3. 현재 구조와 P1~P4 접점

| 프로젝트 | 실파일로 확인한 현재 구조 | P1~P4 접점 | 소유권 결론 |
|---|---|---|---|
| nova-use | `src/shared/ipc.ts`의 `BrowserAgentPageDigest`; `src/main/agent-browser-adapter.ts`의 `pageDigestFromSnapshot`; `src/main/browser.ts`의 snapshot/ref/preflight/deepInspect/click/input/capture/CDP; `policy.ts`, `capability.ts`, `browser-consent.ts`; `agent-control.ts`의 userData 설정 원자 저장 | P1은 digest 타입/순수 변환 확장. P2는 main process userData 저장소. P3는 기존 DOM→CDP/FORCE 경계 보강. P4는 digest 안전성 + 현재 target destructive 이중 게이트 | P1~P4 런타임 단일 소유자 |
| nco | `src/core/company-orchestrator.ts`가 `team_tech-port-01...09` 순서를 강제하고 `scripts/team-runner.sh`가 산출물 경로를 관리. `reflexion.ts`/`mem0-bridge.ts`/`shared-state.ts`는 공유 회고 패턴을 제공 | 단계 의존성과 검증 영수증 전달이 주 역할. P2 설계 패턴만 참고 | nova-use 브라우저 메모리·selector·DOM 실행을 nco에 중복 구현 금지 |
| nova-ax | `state-sync.ts`/`nco-client.ts`는 NCO 관측, `src/core/memory-system.ts`와 `src/index.ts`의 API는 SQLite FTS/embedding recall을 제공 | 향후 redacted 집계·대규모 recall의 선택적 후보. 500건 앱 로컬 P2에는 과대 | P1~P4 제어 경로, 원문 학습 데이터, 필수 런타임 의존성 금지 |
| cli-extensions | `extension/src/content/page-digest.ts`, `extension/src/content/force.ts`, `extension/src/shared/destructive.ts`, shared-learning 문서/테스트, `cli-tool/nco-browser.mjs` | 요구 의미·테스트 시나리오를 추출하는 참고 구현 | 코드 복사 대상이 아니라 동작 계약 참고 |

### 이미 존재해 재구현하면 안 되는 nova-use 기능

- `src/main/browser.ts`: CDP `1.3` attach/sendCommand, bounded DOM/AX snapshot과 stable `@eN` refs, preflight, `deepInspect`, click/input, `executeJavaScript`, capture, CDP 실행.
- `src/main/policy.ts`와 `src/main/capability.ts`: 브라우저 등급, 누적 CDP allowlist, cookie/storage/certificate 우회 영구 거부.
- `src/main/browser-consent.ts`: consent broker와 append-only `0600` 감사 로그.
- `src/main/agent-browser-adapter.ts`: 기존 ANALYZE/INSPECT/FORCE action surface.
- `src/main/agent-control.ts`: app userData 아래 JSON의 임시 파일 + rename + `0600` 저장 패턴.

따라서 `Playwright`, browser-use 런타임, 별도 CDP 클라이언트, 별도 ref 시스템, 별도 policy engine은 후보에서 제외한다.

## 4. 후보 기술 dossier와 선택

| 우선순위 | 선택안 | 기존 코드 접점 | 채택 근거 | 대안과 기각 사유 |
|---|---|---|---|---|
| P1 심층 이해 | 기존 bounded snapshot을 입력으로 하는 main-process 순수 변환: `comprehension`, `affordances`, `playbook`, `autoMission`, `safeToAutostart` 생성 | `BrowserAgentPageDigest`, `pageDigestFromSnapshot` | deterministic fixture 테스트가 가능하고 renderer/웹페이지에 권한을 추가하지 않음 | 브라우저-use/LLM 런타임 추가: 중복·비결정성·라이선스/공급망 증가. raw `executeJavaScript` IPC 공개: 보안 경계 확대 |
| P2 공유 학습 | app userData의 main-process 원자 JSON store, 최대 500건, 직렬화, mode `0600`; 원문 input 금지, API key/email 마스킹; `pageSignature/action/selector/frame`별 반복 실패 차단 | `agent-control.ts`의 원자 저장 패턴, adapter 실행 결과 | nova-use에 native DB 의존성을 추가하지 않고 사용자 프로필 범위에 머묾 | nco/nova-ax SQLite 재사용: 프로세스·프로필 경계를 깨고 native 패키징 증가. `vault.ts` recall 재사용: 문서 검색 의미라 action failure memory와 불일치 |
| P3 FORCE 검증 래더 | 제한된 target에만 `MutationObserver`; `try/finally`에서 반드시 해제; 실제 변화 snapshot 확인; DOM 래더 실패 뒤에만 기존 allowlist/Policy/consent 경유 CDP 상승 | 기존 FORCE action, click/type, preflight, CDP 실행 | WHATWG 표준 API이며 Electron의 기존 WebContents 경계 안에서 시간·대상을 제한할 수 있음 | 무제한 polling: 변화 원인 불명확/비용 증가. raw CDP 우회: 기존 보안 정책 위반. 원본의 disabled 제거/무기한 강행: destructive·동의 정책과 충돌 |
| P4 자율 착수 | digest의 `safeToAutostart`와 **현재 해석된 target의 non-destructive 판정**을 모두 만족할 때만 관찰/비파괴 착수. destructive label은 session auto-approve보다 우선하고 매번 명시 consent | agent-control mission, adapter target resolution, PolicyEngine/consent | stale digest 단독 승인을 방지하고 spec의 destructive gate 유지 | blanket auto-approve/goal 추정 실행: 오탐 시 실세계 변경. `autoMission`을 실행 권한으로 사용: 설명과 권한을 혼동 |
| 품질 벤치마크 | 단위/contract 테스트 + 로컬 고정 HTML fixture를 1차 게이트로 하고, 구현 후 WebArena v0.2.0의 고정 task subset을 별도 환경에서 측정 | nova-use Vitest, 원본 `.mjs` contract | 회귀 원인을 좁히면서 외부 benchmark를 reproducible하게 고정 가능 | 원본 UI의 “5.18x” 문구: 측정 harness/원자료를 찾지 못해 채택 불가. 라이브 사이트만 사용: 변동성과 destructive 위험 |

### P1 구현 인계

- `BrowserAgentPageDigest`에 새 필드를 추가하되 기존 선택 필드는 유지하여 IPC 하위 호환을 보존한다.
- `pageDigestFromSnapshot`은 기존 `snapshot.refs`, title/url, bounded text만 읽는 순수 함수로 유지한다.
- comprehension/affordance/playbook 테스트는 login/search/form/checkout/read-only fixture와 unknown fallback을 포함한다.
- `autoMission`은 설명 문자열이며 권한 토큰이 아니다. `safeToAutostart` 기본값은 판단 불충분 시 `false`다.

### P2 구현 인계

- 저장 항목 최소안: schema version, timestamp, domain/pageSignature, action, redacted selector/frame, strategy, outcome, failure class, success/fail count.
- input value 원문, cookie, token, API key, email 원문은 저장하지 않는다. redaction 실패 시 필드 자체를 버린다.
- recall은 최근성만이 아니라 같은 pageSignature/action의 성공 전략을 우선한다.
- 동일 서명 실패가 임계치를 넘으면 `blocked-repeated-failure`를 반환하고 자동 재시도하지 않는다.
- writer는 main process 하나로 직렬화하며 임시 파일 → rename 후 권한 `0600`을 적용한다.

### P3 구현 인계

- 1단계: 현재 ref/selector를 재해석하고 preflight.
- 2단계: 정상 DOM action 실행.
- 3단계: 제한 시간/대상 MutationObserver로 값·checked·disabled·visibility·DOM 변화를 확인.
- 4단계: 실제 효과가 없을 때만 기존 FORCE fallback.
- 5단계: PolicyEngine 등급, capability CDP allowlist, consent를 모두 통과할 때만 CDP.
- 각 단계 결과에 `attempted`, `effectObserved`, `evidence`, `escalated`를 기록한다. observer는 성공·실패·timeout 모두 해제한다.

### P4 구현 인계

- “지시 없음”은 전체 자동화를 뜻하지 않는다. 먼저 P1 관찰/요약만 수행하고, 안전 판정이 확정된 non-destructive action 하나만 착수 후보가 된다.
- target resolve 후 destructive 분류를 다시 수행한다. navigation 뒤 pageSignature가 바뀌면 이전 안전 판정을 폐기한다.
- submit/purchase/delete/send/permission/credential 계열은 항상 destructive로 취급하고 명시 consent를 요구한다.
- P2의 반복 실패 block은 P4 auto-start보다 우선한다.

## 5. 핵심 파일 worktree SHA-256

commit에 포함되지 않은 dirty/untracked 상태를 재검증하기 위한 보조 식별자다.

| 파일 | SHA-256 |
|---|---|
| nova-use `src/main/agent-browser-adapter.ts` | `b5f7fe0871a213196ba96cf16ab8dd06299b2c7bf5b6fb039d151048fb706779` |
| nova-use `src/main/browser.ts` | `dffe65023fab56908e11ed11b6fea677997705f0821ee1876ac3221582c83f92` |
| nova-use `src/main/browser-consent.ts` | `dafe32b70b5dac42f6ff2ead2c964f9457131967b5e0458a7c339dcac0aeb4eb` |
| nova-use `src/main/policy.ts` | `e9b715e335939ca217a9dbc84160abd269f808452c569e809d8eb2e6e98a908e` |
| nova-use `src/main/agent-control.ts` | `e1a3841e4acd73f005f15382ba188ac93650f80e6a461017f14398878ea24797` |
| nova-use `src/shared/ipc.ts` | `5d5d526b1b220bcd8f28137fb2f9db0901836ddb43cc944c38b0e987c66f51fd` |
| 원본 `extension/src/content/page-digest.ts` | `4348367b3947e156bf04a5091da50096acc737647a473d82cb4f81f42100291e` |
| 원본 `extension/src/content/force.ts` | `8ab79ccc83c1fc5fff19b502a47e88d8462dea0412ad1e7817e2f40d80207741` |
| 원본 `extension/src/shared/destructive.ts` | `01c11ed2a473a8f63c1fb2ca423fc364e2be40452fca83700c019d8ae2a89e43` |
| 원본 `cli-tool/nco-browser.mjs` | `89d726c04ee1bd5e7c1089193fe752e307bb03c44ea905e67d6b07efa4a1e9e7` |
| nco `src/core/company-orchestrator.ts` | `c7d714122cd64cd01f46399d57ea16d60c90c5e766f51f6ac891c27d04549fad` |
| nova-ax `src/index.ts` | `c4826ea384a90278b64376797c59d708d7dd57871ad9959affa84c90e18cb59d` |
| nova-ax `src/agents/registry.ts` | `c139329db1d1f45c1c7d20b1b9e50ff1299acfa5497ae199bb1e4a05ebc4b94c` |

원본 `extension/src/content/force.ts`는 동시 작업으로 이전 조사 해시에서 변경되었다. 위 값은 19:30 KST의 최신 worktree 해시이며, 이 Stage 01 작업은 원본 소스를 수정하지 않았다.

## 6. 공식 출처·릴리스·보안·라이선스·논문·벤치마크

모든 웹 출처는 2026-07-23에 원문을 확인했다.

| 구분 | 버전/commit | 공식 출처 | 확인 내용 | 적용 판단 |
|---|---|---|---|---|
| Electron 릴리스 | `v43.2.0`, tag commit `9b58e96340a34cccaccc08e410e76838b50b0cb2` | https://releases.electronjs.org/release/v43.2.0 / https://github.com/electron/electron/releases/tag/v43.2.0 | 대상 lockfile과 일치. Chromium 150, Node 24 포함 | 채택된 플랫폼 |
| Electron WebContents | v43 문서 | https://www.electronjs.org/docs/latest/api/web-contents/ | `executeJavaScript`, `debugger`가 공식 Electron 접점 | 기존 경계 확장 |
| Electron debugger | v43 문서 | https://www.electronjs.org/docs/latest/api/debugger | CDP transport `attach`/`sendCommand` 공식 API | 기존 CDP 경로만 사용 |
| Electron security | current | https://www.electronjs.org/docs/latest/tutorial/security / https://github.com/electron/electron/security | IPC sender 검증, untrusted content에 Electron/Node API 비노출 권고 | P1~P4 IPC 최소화 근거 |
| Electron advisory | GHSA-q6m5-f73j-m9mc | https://github.com/electron/electron/security/advisories/GHSA-q6m5-f73j-m9mc | affected 42.3.1~42.3.2, fixed 42.3.3 | 43.2.0은 명시 범위 밖 |
| Electron advisory | GHSA-9wfr-w7mm-pc7f | https://github.com/electron/electron/security/advisories/GHSA-9wfr-w7mm-pc7f | 38~41 계열 일부 영향. untrusted config의 `webPreferences` 확산 위험 | 43.2.0은 범위 밖이나 config allowlist 유지 |
| Electron license | main | https://github.com/electron/electron/blob/main/LICENSE | MIT | 직접 플랫폼 의존성 유지 |
| Chrome DevTools Protocol | bundled Chromium 기준 | https://chromedevtools.github.io/devtools-protocol/ | canonical PDL은 Chromium 소스, runtime protocol은 `/json/protocol` | 독립 semver로 가정하지 않고 Electron Chromium에 고정 |
| WHATWG DOM | Living Standard (고정 release 없음) | https://dom.spec.whatwg.org/#mutation-observers | MutationObserver 표준 동작과 `disconnect()` | bounded effect 검증에 사용 |
| Web Platform Tests | current master | https://github.com/web-platform-tests/wpt/tree/master/dom / https://web-platform-tests.org/running-tests/from-local-system.html | DOM 표준 테스트와 로컬 실행법 | MutationObserver 호환성 참고 |
| browser-use snapshot 출처 | `2be09b6c5eb702a9287684b42b27e7042a1aba29` | https://github.com/browser-use/browser-use/commit/2be09b6c5eb702a9287684b42b27e7042a1aba29 / https://github.com/browser-use/browser-use/blob/2be09b6c5eb702a9287684b42b27e7042a1aba29/LICENSE | 양쪽 `THIRD_PARTY_NOTICES.md`가 가리키는 MIT 원출처 | 기존 vendored 고지 유지, 런타임 추가 import 금지 |
| browser-use security | current | https://github.com/browser-use/browser-use/security | critical allowed-domain 우회 공지 존재 | 런타임을 새로 채택하지 않는 보조 근거 |
| WebArena | `v0.2.0`, commit `e32b71e3f5b2463bb102457591bc06c0f2c93acf` | https://github.com/web-arena-x/webarena / https://github.com/web-arena-x/webarena/releases/tag/v0.2.0 | Apache-2.0, stable release, 812개 task 예시 | 구현 후 고정 subset benchmark 후보 |
| WebArena 논문 | ICLR 2024 | https://proceedings.iclr.cc/paper_files/paper/2024/hash/4410c0711e9154a7a2d26f9b3816d1ef-Abstract-Conference.html | 현실적 웹 환경에서 자율 에이전트 평가 방법 제시 | 논문/benchmark 1차 근거 |
| WebArena security | current | https://github.com/web-arena-x/webarena/security | SECURITY.md와 공개 advisory 없음 | 제품 런타임 의존성으로는 채택하지 않고 격리 benchmark만 |

## 7. 재현 명령과 baseline 결과

### nova-use build/typecheck 및 관련 테스트 baseline

대상 소스는 read-only였으므로 제품 파일을 수정하지 않고, config cache와 output만 NCO writable 영역 및 `/tmp`로 돌렸다.

```bash
cd /Users/nova-ai/project/nova-use
npm run typecheck
npm test -- --config /Users/nova-ai/project/nco/.tmp-nova-use-vitest.config.mts \
  tests/agent-browser-adapter.spec.ts \
  tests/browser.spec.ts \
  tests/browser-consent.spec.ts \
  tests/agent-control.spec.ts
npm run build -- /tmp/nova-use-npm-build.3DHpd4 \
  --config /Users/nova-ai/project/nco/.tmp-nova-use-build.config.mts \
  --outDir /tmp/nova-use-npm-build.3DHpd4/out
```

조사 스냅샷 결과:

- `npm run typecheck`: PASS, TypeScript 오류 0.
- 대상 테스트: PASS, 4 files / 44 tests, 470 ms.
- build: PASS, main/preload/renderer 각각 137/1/4716 modules, renderer build 11.53 s.
- build 경고는 writable 임시 outDir이 root 밖이라는 점과 일부 dynamic/static import가 같은 chunk에 남았다는 점이었다. 실패는 아니다.
- `.tmp-nova-use-build.config.mts`는 검증에만 사용한 임시 파일이며 실행 후 삭제했다. 제품 소스 변경은 없다.

공유 작업트리가 이후 변경되어 2026-07-23 19:31 KST에 재검증했다. nova-use 핵심 파일의 기록된 SHA-256은 그대로였고 대상 테스트는 다시 4 files / 44 tests PASS, 전체 타입체크는 TypeScript 오류 0으로 PASS였다. 19:26 KST에 writable `/tmp` root/outDir을 사용한 격리 빌드는 main/preload/renderer 137/1/4716 modules로 PASS였다. 19:21 KST에 일시 관찰된 `ObsidianView.tsx:956` TS6133은 최신 실행에 재현되지 않아 현재 오류로 보고하지 않는다.

```text
npm run typecheck
PASS — TypeScript 오류 0

npm test -- --config /Users/nova-ai/project/nco/.tmp-nova-use-vitest.config.mts \
  tests/agent-browser-adapter.spec.ts tests/browser.spec.ts \
  tests/browser-consent.spec.ts tests/agent-control.spec.ts
Test Files  4 passed (4)
Tests       44 passed (44)

npm run build -- /tmp/nova-use-stage01-root-20260723-1926 \
  --config /tmp/nova-use-stage01-config-20260723.mts \
  --outDir /tmp/nova-use-stage01-20260723-1926
main/preload/renderer 137/1/4716 modules
PASS
```

이 하위작업은 제품 소스를 변경하지 않았다. 타입체크와 빌드는 현재 PASS지만 전체 suite 실패가 남아 있어 T1은 명시적으로 FAIL이다.

관련 44개 테스트의 성공은 P1~P4 접점 baseline일 뿐 회사 목표의 **전체 T1 통과를 뜻하지 않는다**. 전체 suite도 별도로 실행했다.

```bash
cd /Users/nova-ai/project/nova-use
npm test -- --config /Users/nova-ai/project/nco/.tmp-nova-use-vitest.config.mts
```

전체 suite 결과:

- **FAIL**: 42 files / 452 tests PASS, 8 files / 11 tests FAIL, 11 tests SKIP, unhandled rejection 1건.
- sandbox/권한 근거가 명확한 실패는 filetree suite setup, loopback `listen EPERM` 3건, Git ref/worktree/home 쓰기 4건, `sandbox-exec` 적용 1건이다.
- 제약과 별개의 실제 baseline 불일치 1건: `nova-cli.spec.ts`는 command 229 / extension 27을 기대하나 현재 출력은 226 / 24.
- 원인이 확정되지 않은 추가 실패는 automation 계산 test의 5초 timeout 1건과 PC-control lock test의 proxy-response timeout 1건 및 그 unhandled rejection이다.
- 따라서 회사 목표의 `npm build + test` 전체 T1 gate는 이 Stage 01 시점에 **NOT SATISFIED**다. 범위 밖 테스트나 소스를 바꿔 통과로 가장하지 않았다.

### cli-extensions 원본 계약 baseline

```bash
cd /Users/nova-ai/project/크롬확장프로그램/cli-extensions/extension
./node_modules/.bin/tsc --noEmit -p tsconfig.json
node ../tests/repeat-guard.mjs
node ../tests/shared-learning.mjs
node ../tests/learning-integration-contract.mjs
node ../tests/performance-contract.mjs
node ../tests/nco-client-performance.mjs
node ../tests/shared-learning-bridge.mjs
```

결과:

- TypeScript, repeat guard, shared learning, integration contract, performance contract, NCO client performance: PASS.
- `shared-learning-bridge.mjs`: **미검증**. sandbox가 `listen EPERM 127.0.0.1`로 loopback server 생성을 거부했다. 기능 실패라고 판정하지 않는다.
- source UI의 “batch 5.18x” 표시는 원자료/측정 harness를 찾지 못했으므로 benchmark 결과로 인용하지 않는다.

### nco 산출물 저장소 검증

```bash
cd /Users/nova-ai/project/nco
npm run build
npm test -- --run
```

결과:

- `npm run build`: PASS.
- 전체 test: 85 files / 411 tests PASS, 2 files / 2 tests FAIL.
- 기존 실패 1: `tests/근거.test.ts`가 고정값 `2026-07-14`를 기대하지만 현재 `.last`는 `2026-07-23`.
- 기존 실패 2: `smart-router.test.ts`의 예상 cost order와 현재 구현 순서가 불일치.
- 둘 다 이 문서 수정 범위 밖이며, 이 작업에서 소스/테스트를 변경해 숨기지 않았다.

### 제출 형식 게이트

빌드된 실제 `dist/verification/response-quality.js`의 `checkResponseQuality(..., { requireProtocolPrefix: true })`로 두 산출물을 검사했다.

```text
REPORTS/.../browser-control-extension-port-source-discovery-2026-07-23.md
{"pass":true,"heuristics":[]}

data/team-runner/team_tech-port-01-source-discovery-2026-07-23.md
{"pass":true,"heuristics":[]}
```

## 8. 검증 영수증

| 범위 | [변경] | [검증방법] | [등급] | [Gap] | [미검증항목] |
|---|---|---|---|---|---|
| Stage 01 조사 | 허위 출처 제거, 실제 repo/버전/SHA/구조/후보/대안 기록 | 로컬 파일·git·lockfile 직접 조회, 공식 URL 원문 대조 | Evidence Tier 1 | dirty worktree는 HEAD만으로 재현 불가하여 파일 SHA-256 보완 | private repo의 외부 release/security/license는 없음 또는 미확인 |
| P1 인계 | comprehension/affordance/playbook/autoMission 설계 접점 확정 | 기존 digest 타입/변환과 snapshot ref 코드 직접 확인, 관련 tests baseline | 관련 slice PASS | 아직 필드·fixture 구현 전 | P1 기능 테스트/실브라우저 |
| P2 인계 | main-process atomic JSON, 500 cap, redaction, repeated-failure block 선택 | 원본 contract 테스트 및 target userData 저장 패턴 확인 | 관련 slice PASS | bridge loopback test가 sandbox EPERM | concurrency/crash recovery/실프로필 |
| P3 인계 | bounded MutationObserver→기존 FORCE→정책형 CDP 래더 선택 | WHATWG/Electron 공식 문서와 기존 browser/policy/capability 코드 대조 | 관련 slice PASS | ladder 구현 전 | MutationObserver fixture, CDP real-effect 통합 |
| P4 인계 | digest + current-target 이중 non-destructive gate, destructive explicit consent 선택 | spec, consent broker, PolicyEngine, action target 흐름 대조 | 관련 slice PASS | auto-start 구현 전 | destructive E2E와 navigation stale-digest 테스트 |
| 제품 baseline | 현재 build/typecheck/관련 44 tests 통과; full test 별도 실행 | 위 명령과 출력 | **T1 FAIL** | full suite: 11 tests + 1 suite setup 실패; 명확한 환경/권한 실패, CLI inventory 불일치, 미분류 timeout 2건 | 권한 있는 환경의 full suite, inventory 정합화, timeout 원인 규명, signed packaged app |

## 9. 미검증·제약

- 이 Stage 01에서는 nova-use가 workspace writable root 밖이므로 제품 소스를 수정하지 않았다. P1~P4 구현 완료를 주장하지 않는다.
- nova-use, cli-extensions의 공개 upstream/release/security 채널은 git remote로 확인되지 않았다.
- nova-use는 package metadata에 MIT가 있으나 루트 LICENSE가 없다. nco/nova-ax/cli-extensions 자체 라이선스는 확인되지 않았다.
- Electron advisory는 공개 affected range와 현재 lock version만 비교했다. 전체 transitive dependency 취약점 감사나 packaged binary SBOM 검증은 하지 않았다.
- WebArena는 외부 서비스와 계정을 필요로 하므로 실행하지 않았다. 구현 후 v0.2.0 commit과 task subset, seed, container digest를 고정해 별도 격리 환경에서 수행해야 한다.
- 원본 shared-learning bridge의 loopback 통합은 sandbox 제한으로 미검증이다.
- nova-use 전체 suite는 11개 실패 test와 1개 suite setup 실패 및 unhandled rejection 1건이 남아 회사 전체 T1 gate를 만족하지 않는다. 전체 타입체크와 격리 빌드는 현재 통과한다. CLI inventory count 1건은 sandbox와 무관한 실제 baseline gap이며, automation/PC-control timeout 2건은 원인 미확정이다.
- nco 전체 suite의 기존 2개 실패는 범위 밖이며 미수정이다.

## 10. 변경 파일 목록과 핵심 diff

변경 파일:

- `REPORTS/technology-porting/browser-control-extension-port-source-discovery-2026-07-23.md`
- `data/team-runner/team_tech-port-01-source-discovery-2026-07-23.md`

핵심 diff:

- 확인되지 않은 GitHub/arXiv/benchmark 링크와 일반 상태 나열을 제거했다.
- nova-use/nco/nova-ax/원본의 버전, commit SHA, remote, dirty 상태, 라이선스 증거를 실데이터로 기록했다.
- P1~P4의 기존 코드 접점, 채택 기술, 기각 대안, 안전 경계, 다음 단계 인계를 표준 형식으로 정리했다.
- Electron/WHATWG/CDP/browser-use/WebArena의 공식 릴리스·보안·라이선스·논문·benchmark 출처를 검증일과 함께 기록했다.
- nova-use build/typecheck/test, 원본 contract test, nco build/test의 성공과 실패를 숨김없이 영수증으로 남겼다.
- P1~P4 접점과 파일 SHA-256, 공식 후보 기술 및 대안 비교를 별도 상세 dossier에도 고정했다.
- 동시 작업으로 변경된 원본 `force.ts` 해시, 실제 `cli-tool`·nova-ax registry 경로, 최신 nco 테스트 수치를 교정했다.
- 응답/산출물 첫 줄을 품질 게이트가 요구하는 정확한 `done:` 프로토콜 접두사로 교정했다.
- 실제 `checkResponseQuality`로 두 산출물 모두 `FORMAT_MISMATCH` 없이 통과함을 확인했다.

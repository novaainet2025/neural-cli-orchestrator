# 02 안전·라이선스 심사 — cli-extensions → nova-use P1~P4

- 검증일: 2026-07-23 (Asia/Seoul)
- 담당/태스크: `codex` / `task_f2I3glhLCweL8o2s`
- 기준 스펙: `/Users/nova-ai/project/nova-use/docs/plans/browser-control-extension-port.md`
- 원본: `/Users/nova-ai/project/크롬확장프로그램/cli-extensions`
- 대상: `/Users/nova-ai/project/nova-use`
- 증거 등급: Tier 1(로컬 파일·Git SHA·명령 출력), Tier 2(공식 문서·공식 릴리스/보안 공지)

## 결론

**판정: 구현은 조건부 GO, 배포 및 P4 자율착수 활성화는 NO-GO.**

새 의존성을 추가하지 않고, 원본의 동작 개념만 Electron `WebContents`와 기존
`PolicyEngine`/consent/CDP/FORCE 경로에 적응하는 소스 구현은 진행할 수 있다. 그러나 아래
릴리스 차단 항목이 해소되고 T1 전체 build/test 영수증이 확보되기 전에는 패키징·배포 및
P4 자동 실행을 승인할 수 없다.

1. `nova-use/package-lock.json`이 매니페스트와 불일치하고 960개 항목에 `integrity`가 없다.
2. 잠금 파일 유래 SBOM에 라이선스가 기재되지 않은 `@univerjs-pro/*` 27개가 포함된다.
3. generic consent의 `autoApprove`와 remembered 승인이 destructive 동작에도 적용될 수 있다.
4. 원격 페이지를 로드하는 Electron session에 명시적 permission request handler가 없다.
5. 브라우저 학습·감사 데이터가 앱 `userData`가 아닌 공유 홈 경로에 저장된다.
6. 온라인 advisory 조회가 DNS 차단으로 실패해 전체 전이 의존성 CVE 상태는 미검증이다.

## 범위와 고정된 증거

작업 트리는 모두 변경 중이었다. 아래 SHA는 조사 시점의 기준 commit이고, 해시는 조사한
매니페스트/잠금 파일의 정확한 바이트를 고정한다. 기존 변경은 수정하거나 되돌리지 않았다.

| 구성요소 | 기준 commit / 최근 commit 시각 | 매니페스트 SHA-256 | lock SHA-256 |
|---|---|---|---|
| nova-use | `408718d1739bcea747c3c863f75da5ac5a600446` / 2026-07-22 | `52acea9a8cddff98787b0dec6226a38c349afd282372deeea162c36be0d3e01f` | `e737778a351c3e85b23ab375729af763585eb0d34c4911a170ed339cbe6f029d` |
| nco | `4adf31725bad1f44220d04952151c8197469f6e1` / 2026-07-21 | `e4b92286f7985371a752e03bd6c423f478fe823a6c7deae18ab15e389dcdcf4f` | `e68526ba68dba57682b3d7130e4cb5d84bdf5aa4f73822e815f75b838307d002` |
| nova-ax | `7644131db39062ffad62f0a1a61cf55c32bc9ab1` / 2026-07-07 | `8a7aaa085efb9ba6affe4f2209d63bfcce2b7bfe46e2daa569273c8976a518ca` | `72063191fbba37f066696f0179087cb2f896dadf2e6076659cb8cabd078ab4e1` |
| cli-extensions | `cff682d60e1e0579d0bc0bb32088ed2cef313b00` / 2026-07-23 | extension `853ac080…65add9`, bridge `1defc62c…3ad3d` | extension `cee1d4a2…35cd`, bridge `c08d49a8…6070c` |

현재 구조의 접점은 다음과 같다.

| 프로젝트 | 이식 접점 | 안전 경계 |
|---|---|---|
| nova-use | `src/main/agent-browser-adapter.ts`, `browser.ts`, `browser-consent.ts`, `policy.ts` | Electron main에서만 정책 결정; `WebContentsView`는 sandbox/context isolation/node integration off |
| nco | 로컬 에이전트 협업 및 장기기억 | 브라우저 원문·자격증명을 전달하지 않고 최소화된 학습 레코드만 교환 |
| nova-ax | 기존 접근성 snapshot/ref 생산자 | ref와 접근성 메타데이터만 소비; AX 엔진 또는 캡처 기능 재구현 금지 |
| cli-extensions | P1~P4 동작의 참고 원본 | Chrome 권한·브리지·저장 경로·원본 구현을 복사하지 않고 behavior-only 적응 |

## SBOM·의존성·설치 스크립트

### 재현 결과

| 대상 | 잠금 패키지 | `integrity` 누락 | install script 표시 패키지 | CycloneDX 결과 |
|---|---:|---:|---|---|
| nova-use | 1,053 | **960**(필수 범위 509) | `electron-winstaller@5.4.0`, `esbuild@0.25.12`, `node-pty@1.1.0`, `protobufjs@7.6.5`, 중첩 `esbuild@0.28.1` | 1.5 / components 453 / required 243 / optional 210 / license 누락 28 |
| nco | 540 | 0 | `better-sqlite3`, `esbuild`, `fsevents`, `hnswlib-node`, `msgpackr-extract`, `protobufjs` | `ESBOMPROBLEMS`로 실패(mem0ai peer 불일치/누락) |
| nova-ax | 152 | 0 | `better-sqlite3`, `esbuild`, `fsevents` | 생성 가능 |
| cli-extensions/extension | 35 | 0 | `esbuild@0.25.12` | 생성 가능 |
| cli-extensions/local-bridge | 3 | 0 | `node-pty@1.1.0` | 생성 가능 |

`nova-use/package.json:32-56`과 `package-lock.json:12-39`를 직접 비교하면 잠금 파일 루트에만
`@univerjs/presets`, `pdf-lib`, `pdfjs-dist`가 존재한다. 즉, 해당 SBOM은 현재 매니페스트의
권위 있는 배포 구성표로 사용할 수 없다. `npm ci --ignore-scripts --dry-run`도 현재 작업트리
밖 `node_modules/.package-lock.json`을 갱신하려다 `EPERM`으로 실패했으므로 재설치 성공을
주장하지 않는다.

현재 설치 트리의 라이선스 메타데이터에서는 MIT/ISC/BSD/Apache 계열이 대부분이며 GPL/AGPL
계열은 발견되지 않았다. 다만 이 결과는 설치된 트리의 snapshot일 뿐이고, 잠금 파일 유래
SBOM의 라이선스 누락 28건을 해소하지 못한다.

### SEC-PORT-001 — 잠금 파일 무결성·매니페스트 불일치

- 심각도/판정: **High / release blocker**
- 위치: `nova-use/package-lock.json:7-39`; 비교 대상 `nova-use/package.json:32-56`
- 증거: 1,053개 잠금 패키지 중 960개에 registry tarball `integrity`가 없고, 필수 범위만
  509개다. 다른 조사 대상 lockfile은 동일 검사에서 누락 0건이었다.
- 영향: 동일 버전명 아래 변조된 tarball을 검출하지 못하고, CI/배포가 현재 개발 머신과 같은
  의존성 그래프를 재현했다는 증거를 만들 수 없다.
- 조치: 깨끗한 격리 checkout에서 승인된 npm registry와 Node/npm 버전을 고정하고,
  `package.json`을 권위로 lockfile을 재생성한다. diff에서 예상하지 않은 패키지·install
  script·registry URL을 검토한 뒤 `npm ci --ignore-scripts`, SBOM, build/test를 실행한다.
  필요한 native script만 npm의 script allowlist로 명시 승인한다.
- 완화: 이식 코드는 새 패키지 0개로 제한하고 현재 lockfile을 배포 승인 근거로 쓰지 않는다.
- 오탐 검토: 사설 registry가 의도적으로 integrity를 생략했을 가능성은 있으나 lockfile에 그
  사유나 검증 대체수단이 없고, 같은 환경의 다른 세 lockfile과 현저히 다르다.

### SEC-PORT-002 — 라이선스 미확정 Univer Pro 전이 항목

- 심각도/판정: **High / license blocker**
- 위치: `nova-use/package-lock.json:15`; CycloneDX `npm sbom --package-lock-only`
- 증거: license 누락 28개 중 27개가 `@univerjs-pro/*@0.25.1`, 1개가
  `@univerjs/telemetry@0.25.1`이다. Univer 공식 문서는 Pro를 상용 라이선스로 구분한다.
- 영향: 현재 앱에 실제로 필요하지 않은 stale 항목이어도 이를 포함한 배포물을 만들면 사용권과
  고지 의무를 입증할 수 없다.
- 조치: 매니페스트에 없는 stale dependency라면 lockfile 재생성으로 제거한다. 실제 필요하면
  구매/사용 범위와 재배포 조건을 법무·구매 증빙으로 고정하고 SBOM에 라이선스를 보완한다.
- 완화: P1~P4 이식은 Univer 관련 코드를 import하지 않고 새 의존성을 추가하지 않는다.
- 오탐 검토: 해당 패키지가 현재 `package.json`에는 없어 실제 번들에서 제외될 수 있다. 그래서
  “무단 사용 확정”이 아니라 “현 lockfile/SBOM으로 배포 승인 불가”로 판정한다.

### SEC-PORT-003 — install script 공급망 실행

- 심각도/판정: **Medium / controlled execution required**
- 위치: `nova-use/package.json:30`, `scripts/ensure-node-pty-helper.mjs:1-9`
- 증거: root `postinstall`은 `electron-builder install-app-deps`와 local chmod helper를
  실행한다. 잠금 그래프에는 위 표의 5개 install-script 패키지가 있다. local helper 자체는
  macOS `node-pty`의 고정된 `spawn-helper` 경로만 `0755`로 바꾸며 네트워크 호출은 없다.
- 영향: `npm install/ci`를 그대로 실행하면 native build/download 스크립트가 개발자 권한으로
  실행된다.
- 조치: 격리 CI의 첫 단계는 `npm ci --ignore-scripts`; 패키지 tarball·해시·스크립트를
  검토한 뒤 필요한 패키지만 allowlist하고, 자격증명·홈 디렉터리·운영 데이터·외부 쓰기 권한을
  주지 않는다.
- 오탐 검토: install script 존재가 악성임을 뜻하지 않는다. 악성 스크립트는 발견하지 않았지만
  lock 무결성이 깨져 있으므로 무심사 실행을 승인할 수 없다.

## Electron·브라우저 제어 경계

확인된 안전 baseline은 유지해야 한다.

- `src/main/index.ts:19-25,54-110,113-144`: 앱 렌더러의 navigation/window-open guard,
  context isolation, sandbox, node integration off, production CSP가 있다.
- `src/main/browser.ts:972-1004`: remote `WebContentsView`도 context isolation/sandbox를 켜고
  node integration을 끈다.
- `src/main/policy.ts:18-20,55-64,169-192`: main-only default deny, browser capability의
  `net:https`/`cdp:l0-l2`, L3/L4 feature gate가 있다.
- `src/main/browser.ts:543-570`: CDP permanent deny와 level allowlist를 실제 호출 전에 검사한다.
- `src/main/agent-bridge-server.ts:60-63,89-116,218-245`: loopback only, token 필수,
  payload 2 MiB 제한, random token/0600 저장, HELLO-first 인증이 있다.
- `src/main/auth.ts:8-12,109-115,251-255,298-303`: credential은 app `userData`에 OS
  `safeStorage`로 암호화되며 main 밖으로 평문 반환하지 않는다. P1~P4는 이 vault에 접근할
  필요가 없고 접근해서도 안 된다.

### SEC-PORT-004 — remote session permission 요청이 기본 허용

- 심각도/판정: **High / P4 activation blocker**
- 위치: `nova-use/src/main/browser.ts:972-1004`; `src` 전체의
  `setPermissionRequestHandler|setPermissionCheckHandler` 검색 결과 0건
- 증거: Electron 공식 security checklist는 원격 콘텐츠를 로드하는 모든 session에
  `ses.setPermissionRequestHandler()`를 설치하라고 요구하며, handler가 없으면 permission
  request가 기본 승인된다고 설명한다.
- 영향: 자율 브라우징 중 사이트가 notification/media/geolocation 등 Chromium permission을
  요청할 때 nova-use 정책·동의 모델 밖에서 승인될 수 있다.
- 조치: 각 browser partition의 session에 request/check handler를 정확히 한 번 설치한다.
  기본은 deny이며, 필요한 권한만 HTTPS origin + 사용자 gesture + 명시 consent 조건으로
  allow한다. P1~P4는 새 권한을 요구하지 않으므로 초기 구현은 전부 deny가 안전하다.
- 완화: handler가 들어가기 전에는 신뢰하지 않는 원격 사이트의 P4 auto-start를 비활성화한다.
- 오탐 검토: OS 단계에서 다시 거절될 수 있지만 Electron 앱 단계의 allow가 남는 이상 안전
  게이트로 볼 수 없다.

### SEC-PORT-005 — destructive 동의가 auto/remembered 승인에 흡수될 수 있음

- 심각도/판정: **High / P4 blocker**
- 위치: `nova-use/src/main/browser-consent.ts:90-109,133-146,165-170`;
  `src/main/browser.ts:609-625`
- 증거: broker는 `autoApprove`이면 즉시 true를 반환하고, remembered key는
  `origin + tool`뿐이다. auto mode를 켜면 대기 중 요청도 모두 allow한다. 호출자는 action,
  selector 등을 전달하지만 `destructive`/`alwaysAsk` 같은 비우회 risk class를 전달하지 않는다.
- 영향: P4의 “삭제/결제/전송 등은 반드시 사용자 consent”가 session auto-approve 또는 같은
  origin/tool의 remembered 승인으로 우회될 수 있다.
- 조치: main에서 구조화된 `risk: destructive`를 판정하고 해당 요청은 autoApprove와 remember를
  무시하며 매회 사용자의 구체적 확인을 받아야 한다. renderer/agent가 보내는 `confirmed`나
  `destructive:false`는 신뢰하지 않는다. action type + accessible name + 현재 origin과
  preflight evidence를 함께 평가하고 최종 submit/commit 단계 직전에 다시 확인한다.
- 완화: 이 변경과 부정 테스트 전에는 P4 auto-start를 켜지 않는다.
- 오탐 검토: 현 코드에 P4 destructive 분류가 아직 연결되지 않았으므로 현재 exploit 확정이
  아니라, 제안대로 연결할 경우 발생하는 명확한 설계 우회다.

### SEC-PORT-006 — 공유 홈 경로와 과다 메타데이터

- 심각도/판정: **High / P2 blocker**
- 위치: `nova-use/src/main/browser-consent.ts:8-10,30-57`;
  `src/main/agent-browser-adapter.ts:588-610`
- 증거: audit와 page digest가 `app.getPath('userData')`가 아니라
  `~/.nco-cli-ext`에 저장된다. audit에는 raw origin과 selector가 포함되고, page digest는 전체
  JSON을 영속화한다. 파일 모드는 0600이지만 앱별 저장 격리는 아니다.
- 영향: URL query/fragment, selector, page text 또는 계정 식별자가 영속화되거나 legacy CLI와
  의도치 않게 공유될 수 있다. P2 recall이 이를 다시 노출할 수 있다.
- 조치: P2 store와 관련 audit/cache를 `app.getPath('userData')` 아래 전용 디렉터리로 옮기고
  0700/0600을 유지한다. domain은 hostname만, URL은 query/fragment 제거, selector/frame은
  stable hash 또는 최소 fingerprint로 저장한다. 입력원문·페이지 본문·API key·email은 저장하지
  않고, 500개/TTL/크기 제한 및 원자적 쓰기를 적용한다.
- 완화: migration은 명시적 opt-in 또는 one-way import로 하며 legacy 파일을 자동으로 광범위
  읽지 않는다.
- 오탐 검토: 현재 파일 권한은 안전하게 설정된다. 문제는 권한 비트가 아니라 스펙의 앱 격리와
  데이터 최소화 불충족이다.

## 원본 코드에서 가져오지 말아야 할 경계

### SEC-PORT-007 — Chrome 권한·브리지의 과도한 권한

- 심각도/판정: **Medium / do-not-port**
- 위치:
  - `cli-extensions/extension/manifest.json:7-33`: debugger, `<all_urls>`, 모든 HTTP(S)
    frame에 content script
  - `local-bridge/src/server.js:24-42,97-126,128-151`: 홈 경로에 page/capture 저장,
    최대 25 MiB, token 기본 비필수, Origin 없는 client 허용, token 콘솔 출력
- 영향: 이 구조를 Electron에 그대로 옮기면 nova-use의 main-only PolicyEngine과 인증된
  bridge를 우회하고 파일/네트워크 공격면을 넓힌다.
- 조치: manifest/Chrome API/local bridge는 이식하지 않는다. 기존 nova-use의 authenticated
  bridge와 `WebContents` adapter만 사용한다. 외부 원본은 읽기 전용 참고자료로만 취급한다.
- 오탐 검토: 원본은 loopback bind와 Origin 필터를 갖고 있다. 그러나 token opt-in과
  Origin 없는 client 허용은 nova-use의 token 필수 경계보다 약하다.

### SEC-PORT-008 — FORCE ladder의 보호상태 변조

- 심각도/판정: **High / do-not-port**
- 위치: `cli-extensions/extension/src/content/force.ts:126-165`
- 증거: `pierceOverlay`는 pointer-events를 복원하지만 `enable-and-click`은 `disabled`,
  `aria-disabled`, pointer-events를 제거한 뒤 원상복구하지 않는다.
- 영향: 사이트가 의도적으로 막은 버튼을 활성화해 사전조건·중복 제출·파괴적 동작 방어를
  우회할 수 있고 DOM 상태도 오염된다.
- 조치: 대상의 기존 FORCE 처리(`agent-browser-adapter.ts:382-409`)와 CDP allowlist를 유지한다.
  원본에서는 대상 한정 MutationObserver의 검증 개념만 재설계하고, disabled/ARIA/overlay
  보호를 제거하는 전략은 채택하지 않는다. escalation 전후에도 policy/consent를 재평가한다.
- 오탐 검토: 원본의 MutationObserver와 overlay 복원 자체는 유용하다. 파일 전체가 아니라
  검증 invariant만 clean-room으로 적용한다.

### SEC-PORT-009 — label regex만으로 destructive 판정

- 심각도/판정: **Medium / defense-in-depth gap**
- 위치: `cli-extensions/extension/src/shared/destructive.ts:1-5`
- 증거: 한국어/영어 label 정규식 하나이며 action type, form method, URL, 주변 맥락,
  two-step commit 여부를 보지 않는다.
- 영향: 아이콘-only/우회 표현은 false negative, “삭제 안내 보기” 같은 문구는 false positive가
  될 수 있다.
- 조치: P1 affordance의 label regex는 하나의 신호로만 쓰고, submit semantics, destination,
  input type, monetary/account mutation signal, accessible role/name 및 playbook step을 합쳐
  main에서 보수적으로 분류한다. 불확실하면 destructive로 승격한다.

## 비밀정보·파일·키체인·권한

### SEC-PORT-010 — 로컬 nco `.env` 권한

- 심각도/판정: **High / local operational risk**
- 위치: `/Users/nova-ai/project/nco/.env` (내용 또는 값은 보고서에 기록하지 않음)
- 증거: secret-pattern 휴리스틱에서 live-pattern 항목이 있었고 파일 모드는 `0644`, 크기는
  3,974 bytes다. Git에서는 ignored이며 tracked가 아니다.
- 영향: 같은 머신의 다른 계정/프로세스가 읽을 수 있고, 격리되지 않은 외부 install/test
  script가 환경이나 파일을 읽을 경우 credential이 노출될 수 있다.
- 조치: 소유자가 권한을 `0600`으로 축소하고 이미 노출 가능성이 있었던 credential은 회전
  여부를 판단한다. 외부 코드 실행 환경에는 이 파일과 해당 환경변수를 mount/inherit하지 않는다.
- 완화: 이번 심사는 진단 범위이므로 파일 권한이나 credential을 변경하지 않았다.
- 오탐 검토: 패턴 기반 탐지는 값의 유효성을 입증하지 않는다. 그러나 0644 자체는 독립적으로
  최소권한에 어긋난다.

저장소 secret scan은 값이 아닌 경로·행·패턴 종류만 수집했다. nova-use와 원본에서 나온
추가 hit는 fake API key/redaction 검증용 테스트 fixture였고, nova-ax에는 hit가 없었다.
“비밀 0건”을 보증하는 정식 secret scanner/이력 전체 검사는 수행하지 않았다.

macOS entitlement에는 `allow-jit`, `disable-library-validation`, audio input, Apple Events가
현재 존재한다(`nova-use/build/entitlements.mac.plist:5-12`). P1~P4는 이 중 어느 것도 새로
요구하지 않으므로 entitlement·키체인·filesystem 권한을 확대하지 않는다. Credential은 기존
`safeStorage` vault에만 남기고 P1/P2 학습 데이터와 분리한다.

## 라이선스·고지·유지보수

### SEC-PORT-011 — first-party 소유권과 배포 고지 불완전

- 심각도/판정: **Medium / distribution blocker**
- 위치: `nova-use/package.json:7`, untracked `nova-use/THIRD_PARTY_NOTICES.md`,
  `cli-extensions/THIRD_PARTY_NOTICES.md`
- 증거:
  - nova-use는 manifest에 `MIT`를 선언하지만 저장소 루트 LICENSE 파일은 발견되지 않았다.
  - nova-use의 third-party notice는 현재 untracked다.
  - 원본 notice는 browser-use의 `shared/enhanced-snapshot.js`, commit
    `2be09d306840662991d2fb0c2a62f4b62288de2d`, MIT 원문을 명시한다.
  - cli-extensions 자체의 LICENSE/package license와 내부 소유권 증빙은 발견하지 못했다.
- 영향: 사내 코드라도 저작권 소유와 외부 코드 고지·배포 포함 여부를 파일 증거로 재검증할 수
  없다. 스펙의 “라이선스 적합” 표만으로는 근거가 되지 않는다.
- 조치: 회사 내부 소유권을 확인하고 first-party SPDX/license 정책을 정한다. browser-use
  파생부를 재사용하면 MIT notice를 유지하고, clean-room behavior adaptation만 했다면 그
  근거와 참조 commit을 설계 기록에 남긴다. LICENSE/THIRD_PARTY_NOTICES를 tracked 상태로
  만들고 실제 패키지에 포함되는지 archive inspection으로 확인한다.
- 완화: 사용자 지시대로 복붙하지 않고 API/behavior를 Electron 구조에 새로 설계한다.
- 오탐 검토: 사내 비공개 저장소라 별도 LICENSE가 의도적으로 없을 수 있다. 그래도 외부 배포
  승인에는 소유권과 고지 정책의 명시가 필요하다.

유지보수 snapshot은 nova-use 2026-07-22, cli-extensions 2026-07-23, nco 2026-07-21,
nova-ax 2026-07-07에 최근 commit이 있어 “방치됨”으로 판정할 근거는 없다. 버전 자체보다
release cadence, 취약점 대응, lockfile 품질을 계속 gate해야 한다.

## CVE·보안 공지

### SEC-PORT-012 — 전체 advisory 조회 미완료

- 심각도/판정: **Unknown / release blocker**
- 증거: `npm audit --package-lock-only --json`은
  `getaddrinfo ENOTFOUND registry.npmjs.org`로 실패했다. 따라서 “취약점 0건”을 주장하지 않는다.
- 확인된 부분: 설치된 `electron@43.2.0`은 2026-07-21 공식 latest 릴리스이며 서명된 commit
  `9b58e96`, Chromium `150.0.7871.129`를 포함한다. 이는 프레임워크 버전·릴리스 서명에
  관한 확인일 뿐, Electron/Chromium/Node 및 npm 전이 그래프 전체의 advisory 비해당 증거는
  아니다.
- 조치: 네트워크가 허용된 격리 CI에서 고정 lockfile로 `npm audit`, OSV/Dependabot 또는
  동등한 scanner를 실행하고 결과 JSON·DB timestamp를 영수증에 포함한다. high/critical은
  예외 승인 없이 해소한다.
- 오탐 검토: 최신 Electron 사용만으로 전체 npm/Chromium/Node/native dependency의 안전을
  의미하지 않는다.

## P1~P4 안전 설계 판정과 검증 영수증

| 파트 | [변경] 승인되는 범위 | [검증방법] | [등급] | [Gap] | [미검증항목] |
|---|---|---|---|---|---|
| P1 | 기존 snapshot/ref를 소비해 bounded comprehension/affordance를 main에서 계산; 새 dependency 0 | synthetic fixture에서 field 실값·sensitive input redaction·URL query/fragment 미저장 확인 | 조건부 GO / 정적 T2 | 원본 page digest의 full URL/main text/code snippet을 영속화하면 안 됨 | 구현/유닛 테스트/build 미실행 |
| P2 | app `userData`에 최소 fingerprint, 500개 제한, API key/email masking, atomic 0600 write | fake secret/이메일 fixture, 501개 eviction, app profile 간 격리, 동일 signature 반복실패 차단 테스트 | NO-GO / 설계 T2 | 현재 legacy 홈 경로와 과다 page context | 구현/마이그레이션/동시성/TTL 미검증 |
| P3 | 기존 FORCE/CDP/PolicyEngine 위에 대상 한정 effect verification만 추가 | no-effect/target-effect/navigation/value-readback fixture + CDP deny/consent 재평가 테스트 | 조건부 GO / 정적 T2 | disabled/ARIA 제거 전략 금지, escalation 후에도 gate 유지 | 실제 `WebContents` 통합·CDP ladder 미검증 |
| P4 | 비파괴·고신뢰 `safeToAutostart`만; destructive/불확실은 매회 explicit consent | autoApprove=true, remembered=true, icon-only, 다국어, 결제/삭제/전송 fixture가 모두 실행 전 block/ask인지 확인 | **NO-GO / 설계 T2** | generic broker가 destructive를 비우회 등급으로 구분하지 않음; session permission handler 없음 | end-to-end 사용자 consent·TOCTOU·새창/iframe 미검증 |

T1은 회사 목표의 필수 게이트이지만 이 문서는 02 안전·라이선스 심사 산출물이며 소스 구현을
수행하지 않았다. 따라서 nova-use의 `npm run build`와 `npm test` 통과를 대신 주장하지 않는다.
후속 구현 팀은 P1~P4별 영수증과 전체 T1 로그를 별도로 남겨야 한다.

## 외부 코드 평가 격리 정책

1. 원본은 commit `cff682d…`를 읽기 전용으로 고정하고 실행 파일을 대상에 복사하지 않는다.
2. 임시·폐기 가능한 sandbox에서만 검사하며 host `.env`, keychain, real browser profile,
   cookies, 실사용 DB와 프로젝트 루트 쓰기를 제공하지 않는다.
3. 최초 설치는 outbound network deny + `npm ci --ignore-scripts`; tarball hash와 script를
   검토한 뒤 필요한 registry 목적지와 script만 allowlist한다.
4. browser test는 localhost synthetic fixture와 별도 Electron partition을 쓰고, 다운로드,
   file chooser, camera/mic/geolocation/notification permission은 기본 deny한다.
5. P2 store는 synthetic data만 사용하고 secret detector 테스트도 문서화된 fake token만 쓴다.
6. 결과물은 dependency diff, SBOM, license notice, audit report, build/test log와 함께 보관한다.

## 재현 명령과 실제 결과

다음 명령들은 모두 읽기 또는 임시 분석만 수행했다.

```sh
git -C /Users/nova-ai/project/nova-use rev-parse HEAD
shasum -a 256 /Users/nova-ai/project/nova-use/package{,-lock}.json
npm sbom --package-lock-only --sbom-format=cyclonedx
node -e '/* package-lock packages의 integrity/hasInstallScript 집계 */'
rg -n 'setPermission(Request|Check)Handler' /Users/nova-ai/project/nova-use/src
stat -f 'mode=%Lp size=%z path=%N' /Users/nova-ai/project/nco/.env
npm audit --package-lock-only --json
```

실제 결과:

- nova-use SHA `408718d…`; target SBOM components 453, dependencies 454, license 누락 28
- permission handler 검색 0건
- `.env` mode 644, ignored=yes, tracked=no(값 미출력)
- `npm audit` 실패: `ENOTFOUND registry.npmjs.org`
- Node `v25.9.0`, npm `11.12.1`, 설치된 TypeScript `5.9.3`

## 공식 출처

- Electron Security Checklist:
  <https://www.electronjs.org/docs/latest/tutorial/security>
- Electron v43.2.0 signed release:
  <https://github.com/electron/electron/releases/tag/v43.2.0>
- Electron Security Advisories:
  <https://github.com/electron/electron/security/advisories>
- npm SBOM:
  <https://docs.npmjs.com/cli/commands/npm-sbom/>
- npm CI / script controls:
  <https://docs.npmjs.com/cli/commands/npm-ci/>
- Univer Pro license:
  <https://docs.univer.ai/guides/pro/license>
- browser-use upstream/MIT:
  <https://github.com/browser-use/browser-use>

## 변경 파일과 핵심 diff

- 변경: `data/team-runner/team_tech-port-02-safety-license-2026-07-23.md`
- 핵심 diff: 근거 없는 이전 에이전트 지표 보고를 제거하고, commit/hash로 고정한 SBOM·설치
  script·권한·비밀정보·라이선스·유지보수·CVE 심사, 12개 findings, P1~P4 판정, 격리 정책,
  재현 명령 및 미검증 항목으로 교체했다.
- 소스/설정 변경: 없음
- 커밋: 없음

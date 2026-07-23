# OSS 기술 스카우팅 — 리서치 기획·전략 산출물 (진입점)

- 작성일: 2026-07-23
- 담당 팀 하위작업: **리서치 기획·전략팀** (NCO stage = discussion/design, 오케스트레이션 진입점)
- 상위 회사 목표: NCO / Nova-AX / Nova-Use 세 로컬 코드베이스에 **꼭 필요한** 외부 OSS GitHub 레포를 조사·검증해 한국어 최종 보고서 산출
- 본 문서의 성격: **연구질문 정의·범위 설정·방법론 설계 + 탐색·수집팀 핸드오프 스펙**. 외부 레포의 최종 선정/검증은 본 문서 범위 밖(다운스트림 팀 수행). 실제 설치·코드 수정 없음.

> ⚠️ 포맷 주의: 본 산출물은 **텍스트 기획 문서**이므로 코드 diff·빌드·타입체크 게이트 대상이 아님. 자동보강된 `[작업유형]=bugfix` / `[검증기준]=빌드/타입체크 통과`는 이 작업 유형과 불일치(FORMAT_MISMATCH). 게이트 통과를 위해 가짜 diff를 만들지 않음.

---

## 0. 로컬 인벤토리 (근거 기반, T1)

세 저장소의 매니페스트·디렉터리·docs를 직접 읽어 확인한 현재 상태.

### NCO — `/Users/nova-ai/project/nco`
- 런타임: TypeScript ESM, Node ≥22 (`package.json:engines`, T1)
- 이미 의존/통합된 핵심 기능 (`package.json` deps, T1):
  - 웹서버 `fastify` + `@fastify/{cors,helmet,rate-limit,compress}`
  - 저장소 `better-sqlite3`(WAL), 캐시/상태 `ioredis`
  - 작업 큐 `bullmq`
  - **벡터 인덱스 `hnswlib-node`** + 메모리 `mem0ai`
  - LLM SDK `@anthropic-ai/sdk`, `@google/generative-ai`, `openai`
  - 스크래핑 `@mendable/firecrawl-js`, `duck-duck-scrape` + 로컬 `integrations/scrapling/`
  - 텔레메트리 `@opentelemetry/*`, 스케줄 `node-cron`, 검증 `zod`, 로깅 `pino`
  - 보안은 **자체 구현** 모듈: SandboxManager, PathGuard, CommandGate, ResourceLimiter, CircuitBreaker (CLAUDE.md `src/security/`, T2 — 파일 직접 미확인)
- 관측된 후보 공백(가설, 검증 필요): 아래 §2 참조

### Nova-AX — `/Users/nova-ai/project/nova-ax`
- 런타임: TypeScript ESM (`package.json`, T1)
- 이미 의존된 것(매우 얇음, T1): `fastify`, `better-sqlite3`, `ws`, `dotenv` 뿐. devDeps에 **테스트 러너 없음**(vitest 부재).
- src: `agents/ core/ dashboard/ index.ts` (T1). docs는 에이전트 아키텍처·오케스트레이션·inter-session 설계 위주(T1).
- 관측: 오케스트레이션 설계 문서는 풍부하나 **런타임 의존성 스택이 최소** → 큐/재시도/관측/테스트 등 다수의 인프라 공백 가능성.

### Nova-Use — `/Users/nova-ai/project/nova-use`
- 런타임: **Electron**(electron-vite) + React 18, TypeScript, license **MIT** (`package.json`, T1)
- 이미 의존/통합(T1): `@modelcontextprotocol/sdk`, `@monaco-editor/react`+`monaco-editor`, `@xterm/*`, `node-pty`, `tweetnacl`(서명/암호), `zustand`, `react-force-graph-2d`, `react-markdown`+`remark-gfm`, `ajv`, `qrcode`, `ws`.
- src: `main/ preload/ renderer/ shared/ types` (T1). docs: threat-model, mcp-trust-model, app-control, browser-control, hub, release-packaging (T1).
- 관측: 브라우저 제어·MCP 신뢰모델·hub는 이미 상당 부분 구현됨(메모리 `[[project_browser_control_panel_core_already_done]]`, `[[project_appdock_hub_backend_already_done]]`, T4). → 중복 방지 필수.

---

## 1. 연구질문 MECE 분해

**최상위 RQ:** "2026-07-23 기준, 세 제품 각각에 대해 (a) 코드로 증명되는 고우선 공백을 (b) 직접 구현보다 명백히 유리하게 (c) 아키텍처·라이선스 호환으로 (d) 30일 PoC로 측정 가능하게 메우는 유지보수 중인 외부 OSS 레포가 존재하는가? 존재한다면 제품당 0~3개는 무엇인가?"

MECE 하위질문 (상호배타·전체포괄):

- **RQ-1 공백 식별**: 각 제품의 현재 코드/의존성에서 *증명 가능한* 고우선 capability gap은 무엇인가? (로컬 파일 경로 근거 필수)
- **RQ-2 중복 배제**: 후보가 이미 설치/통합된 것 또는 같은 기능의 중복인가? (매니페스트·src grep 근거)
- **RQ-3 build-vs-buy**: 직접 구현 대비 외부 레포 채택이 명백히 유리한가? (구현 난이도·유지보수 부담 비교)
- **RQ-4 통합 적합성**: 후보의 언어/런타임/라이선스가 실제 아키텍처에 통합 가능한가? (ESM/Node, Electron/브라우저, 라이선스 상용성)
- **RQ-5 유지보수 신호**: 후보의 최근 release/commit, archived 여부, 커뮤니티 활성도는? (GitHub 원문 확인, 수치 미확인 시 "미확인" 표기)
- **RQ-6 측정 가능성**: 30일 PoC로 합격/불합격을 가를 정량 기준을 세울 수 있는가?

'꼭 필요' 최종 판정 = **RQ-1(a) ∧ RQ-3(b) ∧ RQ-4(c) ∧ RQ-6(d) 네 조건 동시 충족.** 하나라도 불충족 시 탈락.

---

## 2. 제품별 공백 가설 (탐색·수집팀이 검증할 대상 — 단정 아님)

각 가설은 로컬 근거를 붙였고, 아직 "확정 공백"이 아니라 **검증 대상 가설(H)**. 등급은 근거 성격.

### NCO (가설)
- **H-NCO-1** 재시도/서킷브레이커/타임아웃이 자체 구현(`src/security/CircuitBreaker`)이나, 표준화된 resilience 정책 라이브러리 부재 가능성. (근거: CLAUDE.md, T2) — 단, 이미 자체 CB 존재 → RQ-3에서 build-vs-buy 우위 불명확, **탈락 가능성 높음**.
- **H-NCO-2** LLM 프롬프트/출력 구조화·검증은 `zod` 수동. 스키마 강제 툴콜 프레임워크 공백 가능. (근거: deps에 zod만, T1) — 검증 필요.
- **H-NCO-3** 벡터·메모리는 `hnswlib-node`+`mem0ai` **이미 존재** → 벡터DB류 후보는 **중복 배제(RQ-2)**.
- **H-NCO-4** 스크래핑은 firecrawl+scrapling **이미 존재** → 스크래핑 후보 **중복 배제**.

### Nova-AX (가설 — 공백 후보가 가장 많을 수 있음)
- **H-AX-1** 런타임 스택 최소(fastify/sqlite/ws만). 작업 큐/백프레셔/재시도 부재 가능. (근거: `package.json` deps 4개, T1)
- **H-AX-2** **테스트 러너 부재**(devDeps에 vitest 없음). 단 이는 "외부 기능 레포"가 아니라 개발 도구 → 회사 목표(기능 레포)와 결이 다름, 보고서 본문보다 부록.
- **H-AX-3** 오케스트레이션 설계는 풍부하나 실 구현 인프라(관측·이벤트버스)가 얇음 → NCO에서 검증된 패턴 차용 vs 외부 레포 판단 필요.

### Nova-Use (가설)
- **H-USE-1** 브라우저 제어/MCP hub/서명(tweetnacl)은 **이미 상당 구현** → 관련 후보 대거 **중복 배제(RQ-2)**. (근거: 메모리 T4 + deps T1)
- **H-USE-2** Electron 보안 하드닝(navigation guard 등)은 이미 처리됨(`[[project_nova_use_nav_guards_already_done]]`, T4) → 중복 배제.
- **H-USE-3** 잔여 공백은 렌더러 성능/문서 렌더/뷰포트류일 수 있으나 대부분 nice-to-have → **0개 결론 가능성 명시적으로 열어둠**.

> 핵심 원칙: 회사 목표 4)에 따라 **필수가 없으면 제품당 0개로 결론내는 것이 정답.** 억지 3개 채우기 금지.

---

## 3. 방법론 (탐색·수집팀 실행 절차)

1. **로컬 재확인**: 각 제품 README·매니페스트·`docs/architecture*`·핵심 `src` 직접 read로 §2 가설을 공백/비공백 판정.
2. **외부 조사**: 후보별 정확한 `owner/repo` + URL, 해결 문제, 최근 release/commit·archived 여부, license, 언어/런타임 적합성 확인. **확인 못 한 수치는 "미확인" 표기, 창작 금지.**
3. **필터**: 이미 설치/통합·기능 중복·단순 유명세/nice-to-have 후보 제외(RQ-2).
4. **판정**: RQ-1(a)∧RQ-3(b)∧RQ-4(c)∧RQ-6(d) 동시 충족만 최종 후보. 제품당 0~3개.
5. **근거·등급**: 각 주장에 URL 또는 로컬 경로 + T1~T4 등급 + 미검증 항목 명시.

권장 도구: `nco-search-github` / `nco-search-npm` / `nco-search-pypi`, `WebSearch`/`WebFetch`, `deep-research` 스킬. (등록된 스킬 목록 T1)

---

## 4. 성공기준 (본 리서치 프로젝트 전체)

- 제품별 공백이 **로컬 파일 경로/구체 내용**으로 근거화됨 (막연한 서술 불가).
- 각 최종 후보에 URL·채택이유·기존 대안 불충분 사유·최소 통합경계·30일 PoC 합격기준·난이도·위험·라이선스 6요소 모두 기재.
- 공통 후보/중복제거 원칙 + 탈락 후보 및 사유 섹션 포함.
- 모든 핵심 주장에 근거 + 증거등급 + 미검증 항목. **T3/T4만으로 "필수" 단정 금지.**
- 필수 후보 없으면 "0개" 명시 결론 허용.

## 5. 탐색·수집팀 핸드오프 스펙

- 입력: 본 문서 §1 RQ, §2 가설(H-*), §3 방법론, §4 성공기준.
- 산출물 경로: `docs/technology-transfer/oss-scouting-report-2026-07-23.md` (한국어 최종 보고서).
- 우선순위: Nova-AX(공백 후보 최다 추정) → NCO → Nova-Use(중복 배제 최다, 0개 가능).
- 반환 시 필수: 각 H-*를 "공백 확정 / 비공백(근거)" 로 판정한 표.

---

## 검증 영수증
- [변경] docs/technology-transfer/oss-scouting-research-plan-2026-07-23.md 신규 작성 (기획 문서 1건, 코드 변경 0)
- [검증방법] 세 저장소 `package.json`·디렉터리·`docs/` 목록을 Bash `sed`/`ls`로 직접 확인 후 인벤토리 근거화; 파일 생성은 Write 도구 성공
- [등급] 로컬 인벤토리 = T1(매니페스트 본문 직접 확인); 일부 src/security·이미완료 항목 = T2/T4(메모리·CLAUDE.md 근거, 파일 미개봉)
- [Gap] 본 하위작업(기획·전략) 기준 ~90% — RQ 정의·가설·방법론·핸드오프 완결. 미완: 외부 GitHub 레포 실조사(다운스트림 탐색·수집팀 범위)
- [미검증항목] (1) §2 가설 H-*의 공백/비공백 최종 판정 (2) 외부 후보의 owner/repo·release·license 실측 (3) nova-ax src 코어 파일 직접 개봉(디렉터리만 확인) (4) NCO src/security 실파일

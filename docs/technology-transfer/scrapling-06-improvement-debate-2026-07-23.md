# Scrapling → NCO 이식: 6단계 개선 방향 토론

STEP6_DECISION: KEEP_ADAPTER_BUT_HOLD_RELEASE (현행 어댑터 유지 + S2-01~S2-03 해소 전 배포 보류)

작성일: 2026-07-23
대상: `D4Vinci/Scrapling` 0.4.11 (검토 SHA `07a548362ff904a2837f503ed9d9f6b9dcef0195`, 배포 provenance SHA `aba2b3a...`)
근거 산출물: `integrations/scrapling/`, `src/services/webScrapingService.ts`, `src/server/routes/web-scraping.ts`, migration 080/081, `docs/technology-transfer/scrapling-2026-07-23.md`
승인 범위: 공개·허가된 필드 추출만. CAPTCHA·Cloudflare solving·로그인/유료벽 우회는 범위 밖(불변).

---

## 0. 토론 전제 (T1 사실 고정)

토론은 아래 검증된 사실 위에서만 진행한다. 홍보성 성능 수치나 미검증 주장은 근거로 쓰지 않는다.

1. **현재 채택된 방식은 이미 "래퍼·어댑터"다.** 경계는 Node/Fastify → 크기 제한 JSON stdin(`shell:false`, argv 실행) → 격리 Python `nco_scrapling` 프로세스이며, 정책층(`policy.py`)이 SSRF 차단·robots fail-closed·scope 강제·stealth 이중 게이팅을 담당한다. (`webScrapingService.ts:77-85`, `runner.py`, `policy.py`)
2. **기능 게이트는 통과, 안전 게이트는 STOP.** 2단계 판정 `STOP`, 최종 판정 `RELEASE_BLOCKED`. 미해소 High 3건: S2-01(자식 프로세스에 `...process.env` 전체 전달), S2-02(service worker/DNS rebinding이 `page.route` allowlist를 우회 가능), S2-03(승인이 요청자 자가선언 `authorizationConfirmed:true` 리터럴뿐 + 기본 `0.0.0.0` listen + 토큰 없으면 인증 비활성).
3. **따라서 이 토론의 핵심 질문은 "어떤 이식 방식이냐"가 아니라 "현행 어댑터 경계를 유지·보강할지, 아니면 다른 경계로 갈아탈지"다.** 방식 선택은 S2-01~S2-03 해소 비용에 종속된다.

---

## 1. 다섯 선택지 × 다섯 관점 비교

각 셀은 "현행 어댑터 대비"의 상대 평가다. (↑ 유리 / ↓ 불리 / = 동등)

| 선택지 | 유지보수 비용 | 종속성 | 복잡도 | 운영 위험 | 장기 로드맵 |
|---|---|---|---|---|---|
| **A. 직접 이식(무제한 호출)** | ↑ 단기 낮음 | = | ↑ 낮음 | ↓↓ SSRF·robots·stealth·출력폭주 경계 전무 | ↓ 안전 부채가 누적 |
| **B. 래퍼·어댑터(현행)** | = 업스트림 교체로 흡수 | = pin+lock 재현 | = 프로세스 경계 1겹 | = S2 해소 시 최소, 미해소 시 High 3건 | ↑ 업스트림 추종 용이 |
| **C. 부분 포팅(static만 채택)** | ↑ 표면적 축소로 낮음 | ↑ Playwright/Chromium 제거 | ↑ 브라우저 스택 삭제 | ↑ S2-02(SW/DNS) 소멸, S2-01/03 잔존 | ↓ dynamic/adaptive 로드맵 포기 |
| **D. 자체 재구현(TS)** | ↓↓ parser/adaptive 영구 자체부담 | ↑↑ 공급망 최소 | ↓↓ adaptive relocation 재현 난이도 | = 신규 자작 코드 위험 유입 | ↓ 업스트림 개선 단절 |
| **E. 보류·거부** | ↑ 0 | ↑ 0 | ↑ 0 | ↑ 0 | ↓ 기능 미제공 |

---

## 2. 선택지별 심층 논거·반대의견·반례

### A. 직접 이식 — 공식 패키지 무제한 호출
- **찬성:** 구현 최단, 업스트림 API를 그대로 노출해 기능 손실 0.
- **반대(결정적):** SSRF·robots·stealth·출력 상한이 전부 사라진다. 현행 `policy.py`가 막는 내부망 접근(`_assert_global_ip`)·robots fail-closed(`_check_robots`)·stealth 이중 게이트가 모두 소멸.
- **반례:** 전송 기록 §6 표에서 이미 "거부 — SSRF, robots, 무단 stealth, 출력 폭주 경계 없음"으로 판정됨. 재론 가치 없음.
- **판정: 거부(불변).**

### B. 래퍼·어댑터 — 현행 방식
- **찬성:** ① 업스트림을 TypeScript로 재작성하지 않고 교체 가능(§5). ② 프로세스 경계로 crash·메모리·시간을 격리(stdout 6 MiB·stderr 256 KiB·timeout+15s). ③ JSON 계약으로 쿠키·전체 HTML을 NCO 메모리에 올리지 않음. ④ 정책층이 SSRF/robots/scope/stealth를 코드로 강제.
- **반대:** 현재 경계는 **비밀정보와 내부망을 충분히 격리하지 못한다.** S2-01(env 전체 전달)·S2-02(SW/DNS route 우회)·S2-03(자가선언 승인)이 미해소면 이 방식의 "격리" 주장은 부분적으로만 참이다.
- **반례(자기비판):** "프로세스 격리 = 안전"은 과신이다. `page.route`는 service worker 요청을 못 볼 수 있고(Playwright 공식 문서), DNS 검증과 실제 연결이 분리돼 rebinding에 열려 있다. 즉 어댑터를 골랐다고 SSRF가 자동 해결되지 않는다 — 경계 자체를 보강해야 한다.
- **판정: 유지하되 S2 해소 전 배포 보류.** 개선 방향은 §3.

### C. 부분 포팅 — static Fetcher만 채택, dynamic/stealth 유예
- **찬성:** ① Playwright/Chromium/patchright/browserforge 등 무거운 전이 의존성과 미SBOM 브라우저 artifact(S2-04)를 제거. ② **S2-02(service worker/DNS rebinding via 브라우저)가 원천 소멸** — 이게 가장 큰 이득. ③ curl-cffi 기반 static은 정책 검증이 단순.
- **반대:** dynamic·adaptive selector·stealth 로드맵을 포기. 웹 스크래핑 회사 7팀 charter(081) 중 동적 렌더 의존 업무가 있으면 범위 축소.
- **반례:** static-only여도 S2-01(env)·S2-03(승인)은 그대로 남는다. "브라우저만 빼면 안전"은 거짓 — SSRF 표면의 절반(HTTP fetch·redirect·robots fetch)은 static 경로에도 존재.
- **판정: 유력한 단계적 대안.** S2-02 해소가 지연되면 "우선 static만 released, dynamic은 HOLD"로 배포 범위를 쪼개는 카드로 보존.

### D. 자체 재구현 — 의존성 없는 TypeScript 구현
- **찬성:** 공급망 최소화, THIRD_PARTY_NOTICES·tld MPL-1.1 선택 의무·브라우저 라이선스 부채 회피.
- **반대(결정적):** Scrapling의 parser·**adaptive relocation**(선택자 변경 추종)·브라우저 엔진을 중복 구현해야 하며 범위·회귀 위험이 크다(§1 대안표, §6).
- **반례:** 재구현 코드도 결국 자체 SSRF·robots·출력 상한을 새로 작성해야 한다 — 현행 `policy.py`가 이미 검증해 제공하는 방어를 버리고 미검증 신규 코드로 대체하는 것은 안전 관점에서 후퇴다.
- **판정: 거부.** 단, adaptive가 불필요하다고 판명되면 §C(static 부분 포팅)가 사실상 D의 안전한 축소판 역할을 한다.

### E. 보류·거부 — 이식 자체를 되돌림
- **찬성:** 안전 부채 0. S2 미해소 상태에서 배포하지 않는 것은 현 판정(`RELEASE_BLOCKED`)과 정합.
- **반대:** 코드·migration 080/081·회사 조직은 이미 additive로 존재하고 기능·타입 검증을 통과했다. 전면 롤백은 재현 가능한 자산을 폐기.
- **반례:** "배포 보류"와 "이식 거부"는 다르다. 지금 필요한 것은 **release gate 유지**이지 자산 폐기가 아니다.
- **판정: 부분 채택 — "거부"가 아니라 "배포 보류(release-gated)".** 롤백 절차는 전송 기록 §3에 이미 정의됨(폐기가 아니라 비상시 경로).

---

## 3. 합의 결론 — 현행 어댑터(B) 유지 + 게이트 보강

방식 재선택보다 **현행 경계의 구멍을 닫는 것**이 최소비용·최대안전이다. 우선순위:

1. **S2-01 (env 격리):** `webScrapingService.ts` spawn env를 비밀정보 없는 allowlist로 축소 + 전용 저권한 사용자/컨테이너 + 읽기전용 FS. → 프로세스 격리 주장을 실제로 참으로 만듦.
2. **S2-02 (SSRF 잔로):** `service_workers="block"` 또는 context-level route, 연결 시점 IP 고정/재검증, OS egress deny + SW·DNS-rebinding 회귀 테스트. → C(부분 포팅) 없이 dynamic을 안전화하는 조건.
3. **S2-03 (승인 결합):** 운영 API 인증 fail-closed 강제 + 승인 record ID·주체·허용 도메인·보존기간을 서버측 조회/감사. → 자가선언 승인 제거.
4. (Medium) S2-04 SBOM/browser 고정, S2-05 오류 메시지 일반화, S2-06 adaptive DB `0600`·TTL·동시성 상한.

**대체 경로(우발계획):** S2-02가 기한 내 해소 불가하면 → **C(부분 포팅)**으로 전환해 static만 released, dynamic/stealth는 HOLD. D(자체 재구현)와 A(무제한)는 거부 유지.

---

## 4. 장기 로드맵 관점

- **업스트림 추종:** B는 pin+`uv.lock`으로 0.4.x 보안 패치를 저비용 흡수. advisory·release 재점검을 운영 루틴에 포함(전송 기록 §1 보안 공지 주의).
- **경계 진화:** 정책층(`policy.py`)은 엔진과 독립이므로, 향후 static-only(C)로 축소하거나 다른 fetcher로 교체해도 SSRF/robots/scope 검증 자산은 재사용된다 — 이것이 B를 장기적으로 유지하는 핵심 근거.
- **범위 불변:** 어떤 선택지든 CAPTCHA·Cloudflare solving·로그인/유료벽 우회는 로드맵에 올리지 않는다(`solve_cloudflare=false` 유지).

---

## 5. 검증 영수증

- **[변경]** `docs/technology-transfer/scrapling-06-improvement-debate-2026-07-23.md` 신규 생성 (본 6단계 토론 산출물). 기존 파일·코드 무변경.
- **[검증방법]** 근거를 실제 소스에서 직접 확인: `policy.py`(SSRF·robots·stealth 게이트), `runner.py:107-130`(`page.route` 기반 → S2-02 근거), `webScrapingService.ts:77-85`(env 전체 전달 → S2-01 근거), `web-scraping.ts:17-31`(자가선언 승인 → S2-03 근거), 전송 기록 §2·§6·§9(STOP / RELEASE_BLOCKED 판정) Read.
- **[등급]** T1 (파일 내용·라인 직접 인용).
- **[Gap]** 토론 산출물로서 100% (5선택지 × 5관점 + 반대·반례 + 결론 + 우발계획 모두 포함).
- **[미검증항목]** 본 산출물은 **텍스트 전용 토론 결과물**이므로 코드 빌드/타입체크 대상이 아니다(자동보강된 "빌드/타입체크 통과" 기준은 이 하위작업에 비적용 — diff 없음이 정상). S2-01~S2-03의 실제 수정·회귀 테스트는 후속 이식 단계 몫이며 본 단계에서 수행하지 않았다(현재 판정 `RELEASE_BLOCKED` 불변).

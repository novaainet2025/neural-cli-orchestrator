# Scrapling → NCO 기술이전 실행 기록

PORT_DECISION: REJECT

검증일: 2026-07-23  
대상: `D4Vinci/Scrapling` 0.4.11  
업스트림 commit: `07a548362ff904a2837f503ed9d9f6b9dcef0195`  
이식 방식: 원본 복제 대신 버전 고정 패키지 + 정책 어댑터

## 1. 출처 탐색

1단계 판정: `PASS_WITH_LIMITATIONS`

### 후보와 출처

| 항목 | 2026-07-23 확인 결과 | 공식 1차 출처 |
|---|---|---|
| 후보 | `D4Vinci/Scrapling` 0.4.11 | [공식 저장소](https://github.com/D4Vinci/Scrapling), [PyPI 0.4.11](https://pypi.org/project/scrapling/0.4.11/) |
| 릴리스 | 2026-07-12 공개, 서명 검증된 `v0.4.11`; 릴리스 commit은 `aba2b3a57f3009cb6607dba58bb51863ca48d00d` | [공식 릴리스](https://github.com/D4Vinci/Scrapling/releases/tag/v0.4.11) |
| 검토 대상 SHA | `07a548362ff904a2837f503ed9d9f6b9dcef0195`; 저장소의 `pyproject.toml` 버전은 0.4.11 | [commit](https://github.com/D4Vinci/Scrapling/commit/07a548362ff904a2837f503ed9d9f6b9dcef0195), [고정 pyproject](https://github.com/D4Vinci/Scrapling/blob/07a548362ff904a2837f503ed9d9f6b9dcef0195/pyproject.toml) |
| 배포 provenance | PyPI sdist/wheel은 Trusted Publishing과 attestation을 제공하며 소스 commit은 릴리스 commit `aba2b3a...`다. NCO `uv.lock`의 sdist SHA-256 `92500fe6...da947`은 PyPI 공개값과 일치한다. | [PyPI 파일·attestation](https://pypi.org/project/scrapling/0.4.11/#files), `integrations/scrapling/uv.lock` |
| 라이선스 | BSD-3-Clause, Copyright (c) 2024 Karim Shoair | [고정 LICENSE](https://github.com/D4Vinci/Scrapling/blob/07a548362ff904a2837f503ed9d9f6b9dcef0195/LICENSE) |
| 문서 | Fetcher, DynamicFetcher, StealthyFetcher, CSS/XPath, adaptive selector, Spider를 제공한다. Python 3.10 이상이며 3.10–3.13 classifier가 있다. | [고정 README](https://github.com/D4Vinci/Scrapling/blob/07a548362ff904a2837f503ed9d9f6b9dcef0195/README.md), [공식 문서](https://scrapling.readthedocs.io/) |
| 보안 공지 | 공개된 repository security advisory는 0건이고 `SECURITY.md`도 없다. 이는 취약점 부재 증거가 아니므로 운영 중 릴리스·advisory 재점검이 필요하다. | [Advisories](https://github.com/D4Vinci/Scrapling/security/advisories), [Security policy 상태](https://github.com/D4Vinci/Scrapling/security/policy) |
| 논문 | 공식 자료에서 논문 원문·DOI는 확인되지 않았고 저장소 자체를 가리키는 `@misc` 인용만 제공한다. 따라서 논문 수치나 학술 검증은 채택 근거로 사용하지 않았다. | [공식 citation](https://github.com/D4Vinci/Scrapling/blob/07a548362ff904a2837f503ed9d9f6b9dcef0195/README.md#citations) |
| 벤치마크 | 공식 스크립트는 5,000개 중첩 요소와 100회 반복 방법을 공개한다. 그러나 실행 환경·비교 라이브러리 버전·원시 결과가 고정되지 않아 README의 속도 수치는 재현 가능한 채택 근거에서 제외했다. | [고정 benchmarks.py](https://github.com/D4Vinci/Scrapling/blob/07a548362ff904a2837f503ed9d9f6b9dcef0195/benchmarks.py) |

`07a548...`는 릴리스 태그 `v0.4.11`보다 3커밋 앞서 있다. [공식 비교](https://github.com/D4Vinci/Scrapling/compare/v0.4.11...07a548362ff904a2837f503ed9d9f6b9dcef0195)에서
차이는 README 번역·스폰서 이미지와 Docker workflow뿐이며 `scrapling/` 런타임 코드,
`pyproject.toml`, LICENSE, `benchmarks.py` 변경은 없다. 따라서 NCO가 설치하는 PyPI
0.4.11은 기능 코드 관점에서 검토 SHA와 일치하지만, 배포물 provenance SHA 자체는
`aba2b3a...`임을 구분해 기록한다.

NCO 증거는 `integrations/scrapling/pyproject.toml`의
`scrapling[fetchers]==0.4.11` pin, `uv.lock`의 해시 고정,
`THIRD_PARTY_NOTICES.md`의 고지, `nco_scrapling/cli.py`의 버전·SHA 노출이다.
`src/services/webScrapingService.ts`와 `src/server/routes/web-scraping.ts`는 이 후보를
제한된 JSON 프로세스 경계와 REST 계약으로 연결하며, migration 080/081은 1단계
출처 기록 의무와 승인 범위를 조직 charter로 고정한다.

### 검토 대안

| 대안 | 공식 출처 | 1단계 판단 |
|---|---|---|
| Scrapy | <https://github.com/scrapy/scrapy> | 성숙한 크롤링·추출 대안이지만 브라우저와 adaptive relocation은 별도 조합이 필요 |
| Playwright Python | <https://github.com/microsoft/playwright-python> | 동적 브라우저에는 적합하지만 추출·adaptive selector·robots 정책을 NCO가 더 구현해야 함 |
| Crawlee Python | <https://github.com/apify/crawlee-python> | crawler/browser 통합 대안이지만 현재 이식 범위에 중복 프레임워크를 추가하고 adaptive selector 동등성은 미확인 |
| 의존성 없는 자체 구현 | NCO 기존 TypeScript 코드 | 공급망은 단순하지만 Scrapling의 parser/adaptive 기능을 재구현해야 해 범위와 회귀 위험이 큼 |

1단계 채택 근거는 출처·버전·기능 코드 provenance와 라이선스 명확성이다. 업스트림
홍보성 성능 수치, anti-bot 우회 주장, 출처 불명 코드, 논문이 없는 학술 주장은 채택
근거에서 제외했다. CAPTCHA, Cloudflare solving, 로그인·유료벽 우회 기능은 탐색
대상이더라도 NCO 승인 범위에는 포함하지 않는다.

## 2. 안전·라이선스 심사

2단계 판정: `STOP`

High 위험 두 건과 승인 증명 부재가 해소되기 전에는 배포·운영 승인과 다음 이식 단계를
진행하지 않는다. 이미 비밀정보가 유출됐다는 증거는 없지만, 현재 경계는 비밀정보와
내부망을 충분히 격리하지 못한다.

### 의존성·SBOM과 공급망

- `uv lock --check --project integrations/scrapling`은 29개 package record를 정상
  해석했다. 현재 Python 3.13 환경에는 어댑터를 포함한 27개 distribution이 설치돼
  있다. `uv.lock`은 registry artifact URL과 SHA-256을 기록한다.
- Scrapling 0.4.11 wheel SHA-256 `10b781f9...1876e56`과 sdist SHA-256
  `92500fe6...da947`은 [PyPI 파일·attestation](https://pypi.org/project/scrapling/0.4.11/#files)과
  일치한다. 단, attestation의 소스 SHA는 `aba2b3a...`이고 어댑터가 capability로
  노출하는 SHA는 검토 시점 `07a5483...`이므로 배포 provenance와 검토 SHA를 같은
  값처럼 표시해서는 안 된다.
- Python 3.13에서 확인한 제3자 distribution은 Scrapling 0.4.11 외에
  `anyio 4.14.2`, `apify-fingerprint-datapoints 0.13.0`, `browserforge 1.2.4`,
  `certifi 2026.7.22`, `cffi 2.1.0`, `click 8.4.2`, `cssselect 1.4.0`,
  `curl-cffi 0.15.0`, `greenlet 3.5.4`, `idna 3.18`, `lxml 6.1.1`,
  `markdown-it-py 4.2.0`, `mdurl 0.1.2`, `msgspec 0.21.1`, `orjson 3.11.9`,
  `patchright 1.61.2`, `playwright 1.61.0`, `protego 0.6.2`,
  `pycparser 3.0`, `pyee 13.0.1`, `pygments 2.20.0`, `rich 15.0.0`,
  `tld 0.13.2`, `typing-extensions 4.16.0`, `w3lib 2.4.1`이다. lock에는
  다른 marker용 `colorama 0.4.6`, `exceptiongroup 1.3.1`도 있다.
- `pyproject.toml`의 build backend는 `hatchling>=1.27`로 상한·정확 버전이 없고
  `uv.lock` package record에도 없다. 로컬 어댑터 빌드는 잠금파일만으로 완전히
  재현되지 않는다.
- `scrapling install`은 패키지 설치 훅이 아니라 수동 명령이지만, 실행하면 Playwright
  Chromium 다운로드, `playwright install-deps chromium`, TLD 목록 갱신과
  site-packages marker 쓰기를 수행한다. 확인된 브라우저는 Chrome for Testing
  149.0.7827.55이나 이 바이너리의 artifact hash·라이선스 목록은 NCO SBOM에 없다.
- GitHub에는 [공개 security advisory가 0건](https://github.com/D4Vinci/Scrapling/security/advisories)이고
  [SECURITY.md가 없다](https://github.com/D4Vinci/Scrapling/security/policy).
  이는 취약점 부재 증거가 아니다. `pip-audit`/OSV의 정확한 lock 전체 결과는 이번
  환경에서 확보하지 못했으므로 미검증이다.

### 라이선스

Scrapling 자체는 BSD-3-Clause이며 상업적 어댑터 사용과 호환된다. 설치 metadata와
동봉 license 파일에서 전이 의존성은 BSD, MIT, Apache-2.0, PSF, MPL 계열로 확인했고
즉시 확인되는 비호환 라이선스는 없었다. `tld`는 GPL-2.0-only, LGPL-2.1-or-later,
MPL-1.1 중 선택형이므로 NCO는 MPL-1.1 선택과 의무를 명시해야 한다.

현재 `integrations/scrapling/THIRD_PARTY_NOTICES.md`는 Scrapling 직접 고지만 담고
있다. 전이 의존성, Chromium/FFmpeg 등 브라우저 artifact, 선택 라이선스와 고지 의무가
완성되지 않았으므로 외부 재배포 라이선스 승인은 보류한다.

### 우선순위별 발견 사항

| ID | 심각도 | 위치·증거 | 영향 | 해소 조건 |
|---|---|---|---|---|
| S2-01 | High | `src/services/webScrapingService.ts:77-85`가 Python 자식 프로세스에 `...process.env` 전체를 전달한다. NCO 설정에는 API token류 환경변수가 존재한다. | Scrapling·Playwright·Chromium 취약점 또는 공급망 침해 시 NCO 비밀정보와 동일 사용자 파일에 접근할 수 있다. | 비밀정보 없는 환경변수 allowlist, 전용 저권한 OS 사용자/컨테이너, 읽기 전용 파일시스템과 제한된 data directory를 적용한다. |
| S2-02 | High | `integrations/scrapling/nco_scrapling/runner.py:107-130`은 `page.route`만 사용하고 browser context에서 service worker를 차단하지 않는다. [Playwright 공식 문서](https://playwright.dev/python/docs/network#missing-network-events-and-service-workers)는 service worker 요청이 page route에서 보이지 않을 수 있음을 명시한다. DNS 검증과 실제 연결도 분리돼 있다. | 허가된 공개 페이지가 service worker 또는 DNS rebinding을 이용해 route allowlist를 우회하고 내부망으로 요청할 수 있다. | `service_workers="block"` 또는 context-level route, 연결 시점 IP 고정/재검증, OS egress deny를 함께 적용하고 service-worker·DNS-rebinding 회귀 테스트를 통과한다. |
| S2-03 | High | `src/server/routes/web-scraping.ts:17-31`의 승인은 요청자가 보내는 `authorizationConfirmed: true` 리터럴뿐이다. `src/index.ts:297`은 기본 `0.0.0.0` listen이고 `src/server/gateway.ts:854-867`의 API 인증은 `NCO_API_TOKEN`이 없으면 비활성이다. | 허가 문서나 주체와 연결되지 않은 요청이 공개 추출 권한을 자가 선언할 수 있고, 설정 누락 시 원격 네트워크에서 기능을 호출할 수 있다. | 운영에서 API 인증을 fail-closed로 강제하고 승인 record ID·주체·허용 도메인·보존기간을 서버 측에서 조회·감사한다. |
| S2-04 | Medium | build backend가 미고정이고 수동 browser install artifact가 SBOM 밖이다. capability의 SHA도 PyPI attestation SHA와 다르다. | 동일 lock에서 다른 build/browser artifact가 들어오거나 검토한 소스와 설치 배포물을 혼동할 수 있다. | build backend와 browser revision/hash를 고정하고 CycloneDX/SPDX SBOM 및 provenance를 생성·검증한다. |
| S2-05 | Medium | `src/services/webScrapingService.ts:133-151`은 adapter stderr 일부와 상세 오류를 `WebScrapingError`에 넣고 route가 message를 그대로 반환한다. | 내부 경로·dependency 진단 정보가 API 호출자에게 노출될 수 있다. | 외부 응답은 안정된 오류 코드와 일반 메시지만 제공하고 상세 진단은 비밀정보를 제거해 서버 로그에만 남긴다. |
| S2-06 | Medium | adaptive DB는 `runner.py:43-55`에서 기본 data directory에 생성되며 보존기간·파일 mode가 없다. 요청당 Python/Chromium spawn의 별도 동시성 상한도 없다. | 선택자·source URL 계보가 장기 보존되거나 로컬 사용자에게 읽힐 수 있고, 다수 요청이 CPU·메모리를 고갈시킬 수 있다. | `0700/0600`, 명시적 TTL·삭제 절차, worker queue와 동시성/메모리 상한을 적용한다. |

### 확인된 방어와 미확인 범위

- 확인됨: `shell: false`, JSON 입력 256 KiB 상한, URL credential 차단,
  http/https와 public IP 검사, curl-cffi safe redirect, robots fail-closed,
  dynamic/stealth `allowedDomains`, 필드·항목·출력·시간 상한, stealth 이중 플래그,
  `solve_cloudflare=false`, cookie/header/proxy 입력 API 미제공, 외부 콘텐츠
  `untrusted_external` 표시.
- scoped source와 문서의 패턴 검사에서 하드코딩된 secret은 발견되지 않았다.
- 미확인: 정확한 lock 전체 취약점 스캔, browser artifact SBOM/서명, 운영 egress
  firewall, 운영 파일 ACL·보존 삭제, 승인 record와 API 호출 주체의 결합.

STOP 해제에는 S2-01~S2-03 수정과 회귀 테스트, S2-04 SBOM/provenance 보완,
전이·브라우저 고지 완성, 정확한 lock 취약점 스캔이 모두 필요하다.

## 3. 복구 지점

이식은 새 `integrations/scrapling`, 새 REST route/service, 새 080/081 마이그레이션을
중심으로 추가했다. 기존의 대규모 dirty worktree는 수정하거나 되돌리지 않았다.

DB 롤백 순서:

1. `team_goals`의 `goal_web_scraping_quality_2026_07` 삭제
2. `org_web-scraping` 소속 team의 `team_members` 삭제
3. 해당 team 삭제
4. `org_web-scraping` 삭제
5. 필요할 때만 schema_migrations의 081 기록 삭제

기술이전 회사 080은 기존 로컬 조직을 재현 가능한 마이그레이션으로 만든 것이므로 웹
회사 롤백과 함께 삭제하지 않는다.

## 4. 기준선

이식 전 코드 검색에서 Scrapling 패키지, 웹 스크래핑 회사, 전용 REST route가 없었다.
기존 회사 오케스트레이터 테스트 기준선은 2 files / 45 tests 통과였다.

## 5. 후보 프로토타입과 회귀

5단계 판정: `REJECT`

채택한 경계는 Node/Fastify → 제한된 JSON stdin → 격리 Python 프로세스다.

- 장점: Python 프레임워크를 TypeScript로 재작성하지 않고 업스트림 교체 가능
- 격리: shell 없이 argv로 실행하고 stdout/stderr 크기와 프로세스 시간을 제한
- 계약: 요청과 응답이 JSON이며 쿠키·전체 HTML을 NCO 메모리에 올리지 않음
- 종속성: `uv.lock`과 Scrapling 0.4.11 pin으로 재현

### 격리 A/B 방법

이식 전 NCO에는 동등한 웹 스크래핑 서비스가 없었으므로 “기존 NCO 구현”의 성능값을
만들어내지 않았다. 비교 기준 A는 후보 venv 안의 최소 `lxml 6.1.1` reference이고,
후보 B는 `Scrapling Selector 0.4.11`이다. 이 A/B는 프레임워크 parser overhead를
관찰하는 최소 prototype일 뿐, 기존 서비스 대비 upgrade 수치가 아니다.

- 네트워크를 사용하지 않고 500개 공개 catalogue 항목을 생성했다.
- 양쪽 모두 같은 HTML에서 제목, 이름, 링크, 설명의 4개 필드를 추출했다.
- 별도 Python process에서 cold 1회와 warm-up 5회 후 50회 측정을 한 쌍으로 하여
  실행 순서를 교대하며 7회 반복했다.
- 환경은 macOS 26.5.2 arm64, Python 3.13.13, logical CPU 16개다.
- 실행 명령:
  `integrations/scrapling/.venv/bin/python integrations/scrapling/benchmarks/compare_parser.py --repetitions 7 --iterations 50 --items 500`
- 재현 harness는 `integrations/scrapling/benchmarks/compare_parser.py`, 28개 원시
  표본은 `integrations/scrapling/benchmarks/results-2026-07-23.csv`에 보존했다.

### 측정 결과

아래 값은 7개 표본의 중앙값이다. warm latency는 각 표본 내부 50회 latency의
p50/p95를 다시 중앙값으로 집계했고, RSS는 process peak이므로 증분 메모리가 아니다.

| 지표 | A: 최소 lxml 기준 | B: Scrapling 0.4.11 | B 대비 변화 |
|---|---:|---:|---:|
| 정확도 최솟값 | 100% | 100% | 동률 |
| 오류율 최댓값 | 0% | 0% | 동률 |
| cold process wall | 104.967 ms | 155.923 ms | +48.544% |
| warm p50 latency | 14.152 ms | 14.575 ms | +2.992% |
| warm p95 latency | 32.525 ms | 40.542 ms | +24.646% |
| warm 처리량 | 53.847 ops/s | 49.923 ops/s | -7.288% |
| 50회 CPU time | 0.867 s | 0.855 s | -1.340% |
| peak RSS | 37,158,912 B | 41,828,352 B | +12.566% |

모든 28개 process는 exit 0이었고, 양쪽 출력 SHA-256은
`14befddacb1fcaf4d2d003a07e3c4917c62b98e538c7b1ff5b255e512d30c733`으로
일치했다. 누락 selector는 빈 결과였고 잘못된 selector는 양쪽 모두 거부했다.
NCO 어댑터 단위 테스트는 별도로 항목·전체 출력 상한과 정책 실패를 검사한다.

### 실패·성능 저하와 판정

- 기능·정확도: 측정된 정적 4필드 범위에서는 후보가 기준과 동일했다.
- 성능 저하: 후보의 cold wall은 48.544%, warm p95는 24.646%, peak RSS는
  12.566% 높고 처리량은 7.288% 낮았다.
- 미검증: 실제 HTTP/robots/redirect, Node→Python JSON 경계, dynamic browser,
  adaptive relocation, 장시간 부하와 운영 host 자원은 이 offline parser
  prototype으로 측정하지 않았다.
- 기준선 한계: 동등한 기존 NCO 서비스와 사전 합의된 회귀 한계가 없으므로 이 결과로
  성능 승격을 주장할 수 없다.
- 안전 게이트: 2단계 `STOP`의 High 위험 S2-01~S2-03이 남아 있으므로 기능 정확도와
  무관하게 주 작업트리 이식·배포 승인은 거부한다. CAPTCHA, Cloudflare solving,
  로그인·유료벽 우회는 시험하지 않았으며 승인 범위에도 포함하지 않는다.

## 6. 대안 토론

| 선택지 | 판정 |
|---|---|
| Scrapling 소스 전체 vendor | 보류 — 업데이트·라이선스 고지·보안 패치 추적 비용 증가 |
| TypeScript 재구현 | 거부 — adaptive/browser 엔진을 중복 구현할 가치가 낮음 |
| 공식 패키지 직접 무제한 호출 | 거부 — SSRF, robots, 무단 stealth, 출력 폭주 경계 없음 |
| 정책 어댑터 | 채택 — 기능을 유지하면서 NCO 운영 계약을 강제 |

## 7. 가치판단

Scrapling 직접 라이선스와 기본 기능은 확인됐지만 2단계 안전 게이트가 `STOP`이므로
현재 이식은 승인하지 않는다. S2-01~S2-03과 SBOM·재배포 고지의 해소 증거가 없는 한
기능 테스트 성공은 운영 승인 근거가 될 수 없다.

승인 범위는 공개·허가된 웹 데이터의 필드 기반 추출이다. CAPTCHA, Cloudflare challenge
solving, 로그인·유료벽 우회, 민감정보 대량수집은 승인 범위가 아니다.

## 8. 이식 결과

- 기술이전 회사 9개 팀을 migration 080으로 재현
- 웹 스크래핑 회사 7개 팀을 migration 081로 설립
- 웹 회사를 기술이전 회사의 하위 조직으로 연결
- Scrapling 0.4.11 / Python 3.13 격리 런타임 설치
- `GET /api/web-scraping/capabilities`
- `POST /api/web-scraping/extract`
- static, dynamic, adaptive, 제한적 stealth 계약
- 회사 pipeline 강제와 팀 밖 failover 차단

## 9. 사후 검증

실행 영수증:

- Python unit: 9 tests 통과
- NCO 회사 오케스트레이터 baseline: 45 tests 통과
- 최종 targeted Vitest: 회사 오케스트레이터·REST route 3 files / 51 tests 통과
- TypeScript: `npx tsc --noEmit` 통과
- migration rehearsal: 복제 DB에 080/081 적용, 9팀/7팀 확인
- live DB: 080/081 적용, `technology-porting=9`, `web-scraping=7`
- static probe: `https://example.com` → HTTP 200, `Example Domain`
- dynamic probe: 같은 대상 → HTTP 200, `Example Domain`
- Fastify route probe: capabilities 200 / extract 200 / `untrusted_external`

최종 판정: RELEASE_BLOCKED

## 10. 실행 중 발견사항과 즉시 보강

실제 기술이전 회사 실행 `corun_Y1p7lPIUJMV-34tT`는 1–6단계를 완료했지만,
7단계 모델이 승인·거부 문자열을 함께 출력해 fail-closed `undetermined`가 됐다.
5회 루프 뒤 상태는 `partial`(6/9 완료)이며 8–9단계는 실행되지 않았다. 이를 성공으로
변조하지 않았다.

이 실행에서 나온 S2 항목을 다음과 같이 보강했다.

| 항목 | 보강 |
|---|---|
| S2-01 | Python 자식 환경을 allowlist로 바꾸고 NCO token·AI provider key를 전달하지 않는 테스트 추가 |
| S2-02 | service worker 차단, 브라우저 exact-host scope, public DNS 검증 후 Chromium host resolver IP pin 적용 |
| S2-03 | migration 082 승인 registry, 활성·만료·도메인 서버 조회, `authorizationReference`, NCO API token 미설정 시 fail-closed |
| S2-04 | hatchling 1.27.0 정확 버전과 Scrapling/Playwright 버전을 lock에 고정. 별도 browser artifact SBOM·서명은 잔여 |
| S2-05 | 내부 adapter 진단을 안정된 외부 오류 코드·일반 메시지로 치환하고 회귀 테스트 추가 |
| S2-06 | 기본 동시성 2(최대 8), adaptive DB 30일 TTL, directory 0700/file 0600 적용 |
| Gate reliability | 7단계 응답 첫 줄에 단일 결정만 허용하고 반대 결정 문자열의 예시·설명 출력을 금지하는 계약과 테스트 추가 |

보강 후 검증은 Python 11 tests, targeted Vitest 4 files / 55 tests,
`npx tsc --noEmit`, `uv lock`, static/dynamic `example.com` probe를 통과했다.

현재 운영 판정은 계속 `RELEASE_BLOCKED`다. 코드 수준 High 항목은 보강했지만,
새 출력 계약을 반영한 9단계 회사 재실행과 browser artifact SBOM·서명 확인 전에는
production 승인으로 승격하지 않는다. 로컬 검증 API와 회사 조직 설립은 완료 상태다.

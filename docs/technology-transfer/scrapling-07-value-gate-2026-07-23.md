PORT_DECISION: REJECT

# Scrapling → NCO 이식: 7단계 가치판단 게이트

검증일: 2026-07-23  
대상: `D4Vinci/Scrapling` 0.4.11  
검토 commit: `07a548362ff904a2837f503ed9d9f6b9dcef0195`  
판정 범위: Stage 08 자동 승격, 주 작업트리 이식 승인, production 배포 승인  
허용 범위: 공개·허가된 웹 데이터의 명시적 필드 추출만

## 1. 결론

현재 이식의 **자동 승격과 production 배포를 거부**한다. 이 판정은 Scrapling 또는
현행 정책 어댑터의 영구 폐기를 뜻하지 않는다. 코드 수준의 주요 High 발견사항은 현재
트리에서 상당 부분 보강됐고 제한된 정적 파서 기능도 검증됐지만, 다음 release gate
증거가 아직 없다.

1. 브라우저 artifact의 해시·서명·라이선스를 포함한 완전한 SBOM과 재배포 고지
2. service worker·DNS rebinding·OS egress를 포함한 실제 브라우저 보안 회귀 증거
3. 현재 route가 의존하는 migration 082까지 포함한 복구 절차와 롤백 rehearsal
4. Node→Python→실제 HTTP/dynamic/adaptive 전체 경계의 사전 합의 SLO 기반 비교
5. 보강된 단일결정 계약을 사용한 9단계 회사 파이프라인 재실행 영수증

증거 부족 시 거부하는 7단계 규칙과 기존 `RELEASE_BLOCKED` 상태를 유지한다.

## 2. 종합 게이트

| 평가축 | 현재 판정 | 확인된 근거 | 승격을 막는 잔여 |
|---|---|---|---|
| 안전 | 부분 충족 | env allowlist와 동시성 상한(`src/services/webScrapingService.ts:44-64,90-99,196-214`), 서버측 승인 조회와 인증 미설정 fail-closed(`src/server/routes/web-scraping.ts:114-146,202-208,225-278`), public-IP·robots·scope·출력 상한·비신뢰 표지(`integrations/scrapling/nco_scrapling/policy.py:100-146,167-297`, `runner.py:95-141,244-315`)를 확인했다. **[T1]** | live service-worker/DNS-rebinding 부정 테스트, OS egress deny, 전용 저권한 사용자·읽기전용 파일시스템 증거가 없다. 승인 생성의 `approvedBy`도 인증 주체에서 파생되지 않고 요청 본문을 신뢰한다. 브라우저 artifact SBOM·서명도 미확인이다. |
| 복구 가능성 | 부분 충족 | 웹 회사 081의 additive DB 롤백 순서는 실행 기록 §3에 문서화돼 있고, 080/081은 조직과 팀을 재현 가능한 SQL로 등록한다. **[T1]** | 현재 route는 `web_scraping_authorizations`를 사용하고 migration 082가 그 테이블을 만든다. 기존 롤백 순서는 082와 승인 row를 포함하지 않으며, 보강 후 rollback rehearsal 증거가 없다. |
| 기능 | 제한 범위 충족 | raw CSV의 28개 offline parser 표본은 정적 4필드 정확도 100%, 오류율 0%, 동일 output SHA를 기록한다. 요청/응답에는 `requestedUrl`, `finalUrl`, HTTP 상태, UTC 수집시각, 엔진, robots 준수, `untrusted_external`이 보존된다. **[T1]** | 실제 사이트의 선택자 회복, dynamic/adaptive 정확도, 장시간 부하, 페이지 유형별 완전성은 미검증이다. |
| 성능 | 승격 근거 불충분 | 기록된 중앙값에서 후보는 최소 lxml 기준 대비 cold wall +48.544%, warm p95 +24.646%, peak RSS +12.566%, 처리량 -7.288%다. **[T1: raw CSV + 실행 기록 §5]** | 이는 동등한 기존 NCO 서비스가 아닌 offline parser 비교다. Node 프로세스 경계, robots, 네트워크, Chromium을 포함한 end-to-end 기준선과 합격 한계가 없다. |
| 유지보수 | 조건부 수용 가능 | 소스 vendor 대신 Node/Fastify→bounded JSON→Python 어댑터를 사용하고 `scrapling==0.4.11`, Playwright/Patchright와 hatchling을 고정한다. 업스트림 교체 경계가 분명하다. **[T1]** | Node와 Python의 이중 런타임, 29개 lock package, 별도 Chromium lifecycle을 함께 운영해야 한다. lock 전체 취약점 스캔과 브라우저 갱신 절차는 미검증이다. |
| 라이선스 | 배포 차단 | Scrapling 직접 라이선스는 동봉된 BSD-3-Clause이고 직접 고지는 존재한다(`integrations/scrapling/LICENSE.scrapling`, `THIRD_PARTY_NOTICES.md`). **[T1]** | 현재 notice는 직접 의존성만 다룬다. 전이 의존성의 선택 라이선스와 Chromium/FFmpeg 등 브라우저 artifact의 라이선스·고지가 완성되지 않았다. |
| NCO 적합성 | 조건부 적합 | 공개·허가된 필드 추출, 명시적 scope, robots fail-closed, 우회 기능 금지라는 회사 charter와 어댑터 정책은 일치한다. **[T1]** | 운영 승인 registry·감사·보존·삭제와 배포 인프라까지 포함한 end-to-end 운영 증거가 부족하다. |

## 3. 안전 판단

### 확인된 보강

- 자식 Python 환경은 allowlist로 만들어 NCO API token과 AI provider key를 전달하지
  않는다. 이 동작을 TypeScript 단위 테스트로 확인했다.
- dynamic/stealth 요청은 exact target host가 `allowedDomains`에 있어야 하고,
  service worker 차단 설정, page route, public DNS 확인 후 host resolver mapping을
  조합한다.
- stealth는 요청자 별도 확인과 운영자 환경 플래그가 모두 필요하며
  `solve_cloudflare=False`로 고정된다.
- extraction과 authorization 생성은 NCO API 인증이 설정되지 않으면 503으로
  fail-closed하고, 활성·만료·도메인 범위를 DB에서 조회한다.
- 출력은 필드 50개, 항목 1,000개, 문자 5,000,000자, adapter stdout 6 MiB,
  기본 동시성 2·최대 8로 제한된다.

### 남은 중단 조건

- 현재 Python 테스트는 URL 정책과 필드 상한을 검증하지만 실제 service worker,
  DNS rebinding, redirect 체인, Chromium 연결 시점 IP를 재현하지 않는다.
- application-layer route와 resolver mapping 외에 OS/container egress deny가 적용됐다는
  증거가 없다.
- allowlist가 비밀정보 전달은 줄이지만 자식 프로세스는 여전히 같은 OS 사용자로
  실행된다. 동일 사용자 파일에 대한 격리는 입증되지 않았다.
- 운영 DB에 승인 migration이 적용됐는지, 운영 `NCO_API_TOKEN`이 설정됐는지는
  이 검증에서 확인하지 않았다. 또한 승인 생성의 `approvedBy`는 요청 본문 값이며
  인증 principal·역할에서 파생되지 않으므로 실제 거버넌스 승인자의 신원을 입증하지
  못한다(`src/server/routes/web-scraping.ts:38-44,148-184`).

따라서 코드 보강을 production 격리 보장으로 확대 해석하지 않는다.

## 4. 복구 판단

080은 9단계 기술이전 회사를, 081은 7팀 웹 스크래핑 회사를 additive SQL로 등록한다.
기존 실행 기록 §3은 081 조직·팀·멤버·goal 제거 순서를 제공하고 080을 보존하도록 한다.

그러나 현재 API는 082의 `web_scraping_authorizations` 테이블에 의존한다
(`src/server/routes/web-scraping.ts:114-189`,
`db/migrations/082_web_scraping_authorizations.sql:1-18`). 082 승인 row의 revoke/export,
삭제 순서, 감사 보존 정책과 실제 복제 DB 롤백 rehearsal이 기존 복구 절차에 없다.
따라서 복구 가능성은 “설계됨”까지만 인정하고 “검증됨”으로 승격하지 않는다.

## 5. 기능·성능 판단

`integrations/scrapling/benchmarks/results-2026-07-23.csv`는 동일 fixture의 정적
4필드 추출에서 기준과 후보가 모두 정확도 100%, 오류율 0%이고 출력 SHA가 같음을
보여준다. 이는 최소 parser correctness 증거다.

반면 후보의 기록된 중앙값은 cold wall, warm p95, peak RSS에서 더 높고 처리량은
낮다. 이 차이만으로 후보를 폐기하지는 않지만 성능 향상을 주장할 수도 없다. 특히
실제 HTTP/robots/redirect, Node→Python JSON, dynamic Chromium, adaptive selector,
동시 요청을 포함한 서비스 수준 측정이 없고 사전 합의된 회귀 한계도 없다.

## 6. 유지보수·라이선스·적합성 판단

현행 래퍼·어댑터 방식은 공식 패키지를 무제한 노출하거나 TypeScript로 전부
재구현하는 것보다 기능 경계와 정책 경계를 분리한다. 버전 pin과 `uv.lock`은 재현성을
높인다. 이 방향은 유지할 가치가 있다.

다만 배포물은 Python 전이 의존성과 별도 브라우저 binary를 포함한다. 직접 Scrapling
BSD-3-Clause 파일과 notice만으로는 전체 binary 재배포 고지가 완성되지 않는다.
브라우저 revision/hash, 서명 또는 attestation, 전이 의존성 license 선택, 완전한
CycloneDX/SPDX SBOM이 확보되기 전에는 라이선스·공급망 게이트를 통과한 것으로
판정하지 않는다.

아키텍처 적합성은 공개·허가된 필드 추출 범위에서만 인정한다. CAPTCHA, Cloudflare
challenge solving, 로그인·유료벽 우회, 민감정보 대량수집은 향후 재심에서도 승인
범위가 아니다.

## 7. 재심 조건

아래를 모두 T1 영수증으로 제출한 뒤 7단계를 새로 실행한다.

1. exact lock 취약점 스캔, 브라우저 binary 해시·서명/provenance, 전이·브라우저
   라이선스를 포함한 SBOM과 완성된 재배포 notice
2. service worker, DNS rebinding, redirect-to-private, mixed public/private DNS,
   expired/revoked authorization, 인증 미설정, 승인자 신원 위조, secret/file 접근에
   대한 부정 테스트
3. OS/container egress default-deny와 전용 저권한 실행 계정 또는 동등한 격리 증거
4. migration 082와 승인 row까지 포함한 백업·rollback 절차 및 복제 DB rehearsal
5. static/dynamic/adaptive 대표 fixture의 정확도·완전성·p95·처리량·RSS·오류율 SLO와
   Node→Python end-to-end A/B 결과
6. 새 단일결정 계약을 사용한 1–9단계 재실행과 Stage 09 release/rollback 판정

## 8. 검증 영수증

- **[변경]** `docs/technology-transfer/scrapling-07-value-gate-2026-07-23.md` 신규 생성.
  기존 코드·DB·사용자 파일은 변경하지 않았다.
- **[검증방법]** 지정 소스·migrations 080/081·기존 실행 기록·raw benchmark를 직접
  읽었다. 현재 route의 실제 의존성을 판단하기 위해 migration 082도 읽었다.
- **[검증방법]** `npx vitest run src/core/company-orchestrator.test.ts
  src/services/webScrapingService.test.ts src/server/routes/web-scraping.test.ts`
  → 3 files / 48 tests 통과.
- **[검증방법]** `integrations/scrapling/.venv/bin/python -m unittest discover
  -s integrations/scrapling/tests -v` → 11 tests 통과.
- **[검증방법]** `npx tsc --noEmit` 및 `npm run build` → 모두 exit 0.
- **[검증방법]** `UV_CACHE_DIR=/private/tmp/nco-scrapling-uv-cache uv lock --check
  --offline --project integrations/scrapling` → 29 packages 정상 해석, exit 0.
- **[등급]** 현재 파일 내용·명령 출력·raw CSV는 T1. 기존 문서의 과거 live probe와
  DB 적용 주장은 이번 턴에 재실행하지 않았으므로 과거 영수증으로만 취급한다.
- **[Gap]** 7단계의 안전·복구·기능·성능·유지보수·라이선스·적합성 종합과
  fail-closed 판정은 완료했다. production release 검증은 완료하지 않았다.
- **[미검증항목]** 실제 외부 HTTP/dynamic/adaptive probe, 운영 DB와 API 인증 설정,
  OS egress/파일 격리, browser artifact SBOM·서명, lock 전체 취약점, migration 082
  rollback rehearsal, 보강 후 9단계 회사 재실행.

# Verification receipt — stage 05 isolated browser-control prototype

## P1 — comprehension and affordances

- [변경] 기존 `snapshot.refs`만 소비하는 후보 어댑터에 task type, primary CTA, required inputs, blocking issues, next action, playbook, auto mission, safe-to-autostart, affordance intent/destructive 분류를 추가했다.
- [검증방법] 9개 고정 fixture에 대해 후보 계약값과 기대값을 exact assertion으로 비교하고, 기존 shallow digest의 7개 필드를 baseline과 deep-equal 비교했다.
- [등급] Evidence Tier 1 — 로컬 파일·실행 로그·원시 결과를 직접 확인했다.
- [Gap] fixture 기반 정확도이며 실제 DOM/AX 품질이나 다국어 일반화 정확도가 아니다.
- [미검증항목] Electron `WebContents`, 실제 `snapshotRuntimeBrowserTab`, renderer/IPC 타입 연동.

## P2 — learning, recall, and repeated-failure block

- [변경] action/domain/selector/frame/success/strategy fingerprint, 도메인 recall, 동일 page/action/selector/frame 실패 재실행 차단, lesson/done, 500행 제한, 이메일/API 키 마스킹을 메모리형 프로토타입으로 구현했다.
- [검증방법] 성공 recall 1건, 실패 recall 1건, 동일 실패 차단, 다른 selector 허용, lesson/done 조회, 실제 마스킹 결과, 501건 추가 후 500건 제한을 assertion으로 확인했다.
- [등급] Evidence Tier 1 — `prototype-tests.log`에서 5/5 테스트 통과.
- [Gap] 격리를 위해 디스크 저장을 의도적으로 제외했다.
- [미검증항목] nova-use `userData` 원자적 저장, 프로세스 재시작 recall, 동시 쓰기, 기존 audit/policy hook.

## P3 — FORCE verification ladder

- [변경] dispatch 자체를 성공으로 보지 않고 target-related effect가 있을 때만 `verified:true`, DOM 사다리 소진 시 `escalate:'cdp'`를 반환하는 순수 어댑터를 구현했다.
- [검증방법] 무효 dispatch 2회는 CDP 승격, 두 번째 시도의 target effect는 성공으로 판정하는 두 계약을 exact assertion으로 확인했다.
- [등급] Evidence Tier 1 — 결정적 fixture 테스트 통과.
- [Gap] MutationObserver를 설치하지 않고 effect 신호를 fixture boolean으로 모델링했다.
- [미검증항목] 실제 페이지 mutation/URL/readback, WebContents CDP 승격, consent/capability allowlist 유지.

## P4 — autonomous start and destructive gate

- [변경] 영문/한글 파괴적 라벨을 affordance에 표시하고, 막힘 없이 파괴적 primary CTA를 바로 실행하려는 경우 `safeToAutostart:false`로 판정했다.
- [검증방법] 결제/전송/폐기/계정삭제/게시 fixture와 비파괴 로그인/검색/퀴즈/목록 fixture를 비교했다.
- [등급] Evidence Tier 1 — 9개 fixture 계약 점수에 포함해 검증했다.
- [Gap] 프로토타입은 실행기가 아니므로 실제 consent dialog를 열지 않는다.
- [미검증항목] `browser-consent.ts`, `policy.ts`, `agent-control.ts` 통합 및 실제 destructive 실행 차단.

## A/B and regression

- [변경] baseline/candidate를 별도 Node 프로세스로 7회씩 교차 실행하는 재현 가능한 runner와 원시 JSONL/환경 snapshot을 추가했다.
- [검증방법] 변형당 280,000회, 총 560,000회 실행; raw row 14개 파싱; 오류 합계 0을 확인했다.
- [등급] Evidence Tier 1 — `raw.jsonl`, `environment.json`, `ab-summary.md` 보존.
- [Gap] 평균 지연 1.67→5.65µs/op(+238.90%), 처리량 -70.52%로 20% 성능 경보를 통과하지 못했다. 절대 지연 증가는 약 3.98µs/op이다.
- [미검증항목] 실제 Electron/browser/network/disk 성능, 장시간 heap 안정성, 통계적 신뢰구간.

## Build and test receipt

- [변경] nco production TypeScript 소스는 수정하지 않았다.
- [검증방법] `npm run build`; `node --test prototypes/browser-control-port/adapter.test.mjs`; focused nco test 2개; nco 전체 `npm run test:run`; SQLite lock 실패 파일 단독 재실행.
- [등급] Evidence Tier 1 — build exit 0, prototype 5/5, focused nco 16/16. 전체 nco는 84/87 files, 410/413 tests 통과 후 3건 실패했다. SQLite lock 실패는 단독 재실행에서 3/3 통과했다.
- [Gap] 전체 nco T1은 통과하지 않았다. 잔여 실패는 `tests/근거.test.ts`의 2026-07-14 하드코딩 대비 현재 포인터 2026-07-23, `smart-router.test.ts`의 provider 순서 기대 불일치다. 둘 다 Stage-04 baseline 로그에도 존재하며 이번 프로토타입 경로와 무관하다.
- [미검증항목] nova-use `npm run build`와 전체 `npm test`는 실행하지 않았다. 이 단계는 주 작업트리 이식 전 격리 프로토타입이므로 nova-use T1 acceptance를 대체하지 않으며, 실제 이식 뒤 별도 T1 영수증이 필요하다.

## Evidence files

- `ab-summary.md`
- `raw.jsonl`
- `environment.json`
- `logs/prototype-tests.log`
- `logs/nco-build.log`
- `logs/nco-focused-tests.log`
- `logs/nco-full-tests.log`
- `logs/nco-dispute-rerun.log`

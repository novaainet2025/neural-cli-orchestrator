done: [Evidence Tier 1] 지정 스펙과 02~05 산출물, 실제 nova-use/nco/nova-ax 코드 경계를 대조해 개선 방향을 확정하고 품질 게이트 형식을 교정했습니다.

# 06 개선 방향 토론팀 — 검증 산출물 (2026-07-23)

## 판정

`CONDITIONAL_GO_NATIVE_PARTIAL_PORT_WITH_THIN_ADAPTERS`

- P1/P3 구현: 조건부 GO
- P2/P4 활성화: 안전 게이트 해소 전 NO-GO
- 외부 배포: lockfile/SBOM/CVE/소유권·라이선스 확인 전 NO-GO
- 제품 성능: 미확정

P1~P4 기능 범위는 유지하되 Chrome MV3 구현을 직접 복사하지 않는다.
nova-use의 stable ref, FORCE, CDP, deepInspect, capture, PolicyEngine을
그대로 사용하고, 플랫폼 경계에만 얇은 Electron 어댑터를 둔 부분 포팅을
채택한다.

## 근거 요약

- 02 안전·라이선스: 구현 조건부 GO이나 P2/P4·배포는 NO-GO다.
  generic auto/remembered consent, 공유 홈 저장, permission handler 부재,
  lockfile/SBOM/license/CVE 미확정이 차단 항목이다.
- 03 복구: `RECOVERY_GATE: READY`. fresh checkpoint, 지속 설정 백업,
  nova-use 격리 worktree가 생성됐다. main의 핵심 10파일은 dirty이므로
  소유자/hunk 조정 없이 덮어쓰지 않는다.
- 04 기준선: nco build, nova-use build, nova-use browser focused 44 tests는
  각 3회 PASS다. nova-use 전체 suite는 RED라 회사 T1은 미충족이다.
- 05 격리 A/B: gap-contract 61/61, legacy parity 100%, runtime error
  0/280,000으로 기능·호환성은 PASS다. 평균 지연 1.67→5.65 µs/op
  (+238.90%), peak RSS 55.91→64.20 MiB(+14.84%)로 microperformance
  alert가 있으며 Electron 제품 경로 성능은 미확정이다.

먼저 생성된 `team_tech-port-05-upgrade-regression-2026-07-23.md`는 A/B를
미확인으로 기록하지만, 후속 timestamped `ab-summary.md`, `raw.jsonl`,
`environment.json`이 실제 존재한다. 판정은 더 최신인 원시 증거를
우선한다.

## 선택지 비교

| 선택지 | 판정 | 이유 |
|---|---|---|
| 직접 이식 | 거부 | chrome.*·content script·bridge는 Electron 권한/수명주기와 다르고 복붙 금지 |
| 래퍼/어댑터 | 부분 채택 | WebContents 실행, CDP escalation, userData I/O 경계에만 얇게 사용 |
| 부분 포팅 | 주 전략 | P1 추론, P2 fingerprint/guard, P3 effect receipt, P4 분류 계약만 적응 |
| 자체 재구현 | 제한 채택 | Electron glue와 bounded local store만 clean-room 구현 |
| 보류/거부 | 부분 채택 | P2/P4 활성화, 성능 향상 주장, 외부 공유 backend, 배포는 gate 전 보류 |

## 공통화와 프로젝트별 차이

공통화 후보는 직렬화 가능한 계약과 fixture 의미뿐이다:
page/action identity, learning receipt, repeat-guard decision,
destructive decision, force receipt, benchmark row.

- nova-use: 유일한 브라우저 실행 주체, WebContents/CDP, preflight,
  consent/policy, app-local 500건 learning store를 소유한다.
- nco: 향후 opt-in된 마스킹 lesson의 비동기 수신 후보일 뿐 브라우저
  실행·consent·nova-use userData를 소유하지 않는다.
- nova-ax: 대규모 recall이 필요할 때의 선택적 backend 후보이며 현재
  bounded JSON 기본 저장소나 Electron lifecycle을 소유하지 않는다.
- cli-extensions: 동작 oracle와 fixture 의미만 제공하며 Chrome API,
  content script, local bridge, 저장 경로는 이식하지 않는다.

## 구현 게이트

1. 격리 경로 `/Users/nova-ai/project/nova-use-browser-control-port`만 사용한다.
2. dirty 핵심 10파일의 소유자/hunk를 먼저 조정한다.
3. P1→P2→P3→P4 순으로 fixture와 receipt를 먼저 고정한다.
4. destructive/불명확 action은 autoApprove/remembered approval을 무시하고
   매 실행 fresh explicit consent를 요구한다.
5. Electron/WebContents, disk persistence, consent를 포함한 A/B를 재실행해
   기능 100%, legacy parity 100%, runtime error 0을 하드 게이트로 둔다.
6. nova-use 전체 `npm run build`와 `npm test`가 통과하기 전 T1 완료를
   주장하지 않는다.

## 검증 영수증

- `npm run build` → `tsc`, exit 0
- `node --test prototypes/browser-control-port/adapter.test.mjs` → 5/5 PASS
- `npm run test:run -- tests/trajectory-guard.test.ts tests/response-quality.test.ts`
  → 2 files/16 tests PASS
- 실제 `checkResponseQuality(..., { requireProtocolPrefix: true })` →
  두 산출물 모두 `pass:true`, heuristics 0
- Gap: nova-use 전체 suite는 기존 RED이며 이번 06단계는 제품 소스를
  변경하지 않았다. 따라서 회사 T1 완료를 주장하지 않는다.

## 변경 파일 목록

- `REPORTS/technology-porting/browser-control-extension-port-improvement-debate-2026-07-23.md`
- `data/team-runner/team_tech-port-06-improvement-debate-2026-07-23.md`

## 핵심 diff 요약

- 에이전트 성공률 중심의 무관한 이전 내용을 실제 스펙·코드·02~05
  근거에 기반한 P1~P4 설계 결정으로 교체했다.
- 직접 이식/래퍼/부분 포팅/자체 재구현/보류·거부를 비교하고,
  nova-use/nco/nova-ax/cli-extensions의 소유 경계를 분리했다.
- 복구 READY, A/B 기능 PASS·성능 alert, 전체 T1 RED를 반영했다.
- 제출 첫 줄을 `done: [Evidence Tier 1]` 프로토콜로 맞췄다.

## unverified/remaining

- P1~P4 제품 구현과 Electron E2E는 이 단계에서 수행하지 않았다.
- 제품 수준 latency/throughput/CPU/RSS와 P2 disk persistence는 미검증이다.
- destructive fresh-consent, session permission handler, TOCTOU,
  새창/iframe 안전성은 미검증이다.
- nova-use 전체 test가 RED이므로 회사 T1은 미충족이다.

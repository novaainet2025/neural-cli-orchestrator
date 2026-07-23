# 07 이식 가치판단·리포트팀 — 검증 산출물 (2026-07-23)

PORT_DECISION: CONDITIONAL_GO_IMPLEMENTATION

MERGE_RELEASE_DECISION: NO_GO

P4_ACTIVATION_DECISION: NO_GO

done: [Evidence Tier 1] 지정 스펙, 현 nova-use/원본 소스, Stage 01~03·기준선 자료, Git 상태, package/license metadata, 격리 typecheck/build/test 원시 로그를 직접 확인했다.

## 1. 결론

- clean-room 부분 포팅과 얇은 Electron adapter 방식의 P1~P4 구현 가치는 충분하다.
- 현재 작업트리 병합, P4 자동착수 활성화, 패키징·배포는 승인하지 않는다.
- P1/P3는 기존 snapshot/ref와 FORCE/CDP/PolicyEngine 경계 안에서 조건부 착수할 수 있다.
- P2는 app `userData` 격리·500건 제한·redaction·원자 쓰기 뒤에, P4는 destructive `alwaysAsk`와 permission 기본 deny 뒤에 착수한다.
- nco·nova-ax에는 브라우저 런타임을 이식하지 않고 redacted 계약과 검증 schema만 공통화한다.

상세 근거 표와 방법·한계·재심사 조건은
`REPORTS/technology-porting/browser-control-extension-port-value-gate/report.html`에 있다.

## 2. 검증 영수증

| [변경/관찰] | [검증방법] | [등급] | [Gap] | [미검증항목] |
|---|---|---|---|---|
| P1~P4 현 구현 공백 | IPC/digest/FORCE/consent/저장 경로 직접 검사 | Tier 1 | 대상 기능 미구현 | 신규 fixture·E2E |
| nova-use typecheck | 격리 복제 `npm run typecheck` | Tier 1 | 없음 | 원본 경로 직접 쓰기는 sandbox 제한 |
| nova-use build | 격리 복제 `npm run build` | Tier 1 | 기존 chunk warning | package archive |
| 브라우저 집중 회귀 | 4 files, 44/44 tests, exit 0 | Tier 1 | P1~P4 신규 fixture 없음 | Electron WebContents E2E |
| nova-use full test | 45 files pass, 5 fail; 463 pass, 9 fail, 2 skip; exit 1 | Tier 1 | T1 실패 | unrestricted CI 재실행 |
| 성능 | 기준선과 생성 스크립트 data-quality 심사 | Tier 1 | 동등 조건 candidate A/B 없음 | latency/throughput/CPU/RSS/error/success |
| 복구 | Stage 03 파일·절차·현재 dirty 상태 재확인 | Tier 1 | fresh checkpoint/worktree/rehearsal 없음 | 실제 revert/restore/rebuild |
| 라이선스 | LICENSE/package/notice/lock/SBOM 심사 자료 대조 | Tier 1/2 | 소유권·배포 lockfile 미확정 | legal 확인·advisory·archive inspection |
| 보고서 | canonical artifact validation + portable HTML verifier | validation/package PASS; structural_only | configured Chromium executable 부재 | chart SVG·source dialog·desktop/narrow viewport QA |
| nco 보고서 회귀 | `npm run test:run -- tests/browser-control-extension-port-value-gate.test.ts` | Tier 1; 3/3 pass; exit 0 | 자연어 라벨을 필터로 넘긴 자동 호출 2회는 무효 | nco 전체 suite 411/413; 범위 밖 기존 실패 2건 |

## 3. 변경 파일 목록

- `REPORTS/technology-porting/browser-control-extension-port-value-gate/artifact.json`
- `REPORTS/technology-porting/browser-control-extension-port-value-gate/report.html` (builder 생성)
- `REPORTS/technology-porting/browser-control-extension-port-value-gate/source-notes.md`
- `REPORTS/technology-porting/browser-control-extension-port-value-gate/evidence/*`
- `data/team-runner/team_tech-port-07-value-gate-report-2026-07-23.md`
- `tests/browser-control-extension-port-value-gate.test.ts`

## 4. 핵심 diff 요약

- 근거 없는 전면 거부와 무관한 에이전트 성공률 표를 제거했다.
- 안전·복구·기능·성능·유지보수·라이선스·세 프로젝트 적합성을 실파일과 명령 결과로 평가했다.
- 구현 착수와 병합/활성화/배포 결정을 분리했다.
- baseline data-quality 결함과 full-suite T1 실패를 숨기지 않고 재심사 조건으로 고정했다.

unverified/remaining: P1~P4 실제 구현, 동등 조건 A/B, fresh recovery checkpoint/worktree, rollback rehearsal, unrestricted CI full test, permission/destructive E2E, first-party 소유권·clean lockfile/SBOM/advisory/package notice 검증. nco 전체 suite도 보고서 범위 밖 기존 실패 2건 때문에 411/413 상태다.

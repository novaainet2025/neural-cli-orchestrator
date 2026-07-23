# Browser-control P1~P4 value-gate source notes

## Reporting job

- Question: Is adapting cli-extensions P1–P4 into nova-use worth doing, and what may proceed now?
- Audience: technical owners of nova-use, nco, and nova-ax.
- Scope date: 2026-07-23 KST.
- Baseline: current nova-use source at HEAD `408718d1739bcea747c3c863f75da5ac5a600446` plus dirty working-tree content copied at verification time.
- Success criterion: separate implementation value from merge, activation, and release authority; preserve explicit unknowns.
- Decision-useful output: one conditional implementation decision, one merge/release decision, phase gates, project boundaries, and re-review conditions.

## Technical-report structure mapping

| Required role | Visible report section |
|---|---|
| Title | `브라우저 제어 P1~P4 이식 가치판단 보고서` |
| Technical summary | `구현 가치는 충분하지만 병합·활성화·배포 조건은 아직 충족되지 않았다` |
| Key findings with evidence | value-gate, phase, project-fit, and verification tables |
| Scope, data, definitions | `판정 범위와 지표 정의` |
| Methodology | `파일·Git·명령 출력을 우선하고 이전 자동 보고는 교차검증했다` |
| Limitations and robustness | `가장 큰 불확실성은 A/B 부재와 실행되지 않은 복구·배포 검증이다` |
| Recommended next steps | `다음 단계는 격리 구현보다 먼저 복구·동의 경계를 고정하는 것이다` |
| Further questions | `재심사 전에 답해야 할 질문` |

## Evidence inventory

| Evidence | Observed identity | Use |
|---|---|---|
| Port specification | `nova-use/docs/plans/browser-control-extension-port.md` | Scope, constraints, T1 |
| Current target source | HEAD `408718d…`; relevant file hashes below | Current P1–P4 gap and existing primitives |
| Stage 01 discovery | `data/team-runner/team_tech-port-01-source-discovery-2026-07-23.md` | Source/oracle and architecture |
| Stage 02 safety/license | `data/team-runner/team_tech-port-02-safety-license-2026-07-23.md` | Security and distribution blockers |
| Stage 03 recovery | `data/team-runner/team_tech-port-03-recovery-checkpoint-2026-07-23.md` | Recovery readiness |
| Baseline | `nova-use/docs/plans/benchmark-baseline.md` and `scripts/run-benchmark.sh` | Data-quality assessment only |
| Isolated T1 logs | `evidence/nova-use-*.log` | Current build/test receipt |

Current source SHA-256:

```text
agent-browser-adapter.ts b5f7fe0871a213196ba96cf16ab8dd06299b2c7bf5b6fb039d151048fb706779
agent-control.ts         e1a3841e4acd73f005f15382ba188ac93650f80e6a461017f14398878ea24797
browser-consent.ts       dafe32b70b5dac42f6ff2ead2c964f9457131967b5e0458a7c339dcac0aeb4eb
browser.ts               dffe65023fab56908e11ed11b6fea677997705f0821ee1876ac3221582c83f92
policy.ts                e9b715e335939ca217a9dbc84160abd269f808452c569e809d8eb2e6e98a908e
ipc.ts                   5d5d526b1b220bcd8f28137fb2f9db0901836ddb43cc944c38b0e987c66f51fd
package.json             52acea9a8cddff98787b0dec6226a38c349afd282372deeea162c36be0d3e01f
package-lock.json        e737778a351c3e85b23ab375729af763585eb0d34c4911a170ed339cbe6f029d
```

## Data-quality assessment

Intended grain is one comparable scenario run per baseline/candidate, with identical hardware, inputs, concurrency, repetitions, and statistics. The available baseline does not contain that grain.

| Check | Finding | Severity | Analytical impact |
|---|---|---|---|
| Completeness | Cold/warm latency, throughput, CPU, RSS, error rate, success rate, repetitions, and confidence intervals are absent | High | No performance uplift/regression claim |
| Validity | `du -sh .` measures the repository, dependencies, caches, and outputs together | High | “Build size” is not a build artifact size |
| Consistency | cli-extensions root lacks `package.json`, but extension and local-bridge have separate packages | High | Source baseline skipped both actual components |
| Comparability | No candidate prototype/A-B rows exist | Critical for performance decision | Performance stays `UNKNOWN` |
| Test integrity | The baseline catches failures but then writes the ambiguous message `Test failed or no test script` | Medium | Exit reason must be read from raw logs |
| Freshness | Same-day source and commands were rechecked | Low | Current-state claims are usable |

Remediation: replace the script with per-package commands, artifact-only size, warm-up and repeated scenario runs, per-run raw rows, p50/p95 and dispersion, CPU/RSS sampling, and a fixed failure taxonomy. Do not automate threshold decisions until the scenario definition is stable.

## Table and visual contract

One chart is rendered: a single-series categorical bar of the eight verification receipts grouped by exact status (`PASS` 4, `BLOCKED` 2, `FAIL` 1, `MISSING` 1). Its analytical question is “how many checks are in each evidence state?” and its takeaway is that successful baseline checks coexist with blocking evidence. The chart does not encode a score, weight, trend, or release probability. The subtitle and adjacent paragraph state that one blocking result prevents release approval.

No performance chart is rendered because baseline/candidate A/B rows do not exist. The requested gate evidence remains a seven-row exact lookup plus four phase rows, three project-boundary rows, and eight verification rows. Tables use spacious report density, explicit default order, neutral status text, and adjacent interpretation. The chart uses one palette root with axis labels as the non-color distinction; no redundant legend or red/green-only encoding is used. The final HTML reader is the QA surface at desktop and narrow width.

## Robustness checks

- Re-read the designated spec before all project evidence.
- Compared the current IPC/digest/FORCE/consent source to both the specification and original oracle symbols.
- Re-ran typecheck, production build, full tests, and focused browser tests from an isolated copy of the current source.
- Kept full-test exit `1` as T1 failure even though eight failures appear environment-related.
- Treated the CLI inventory mismatch as a real contract discrepancy until owners confirm the expected count.
- Rejected performance, maintenance reduction, and license suitability claims that lacked direct evidence.

## Generated report QA

`artifact.json` is the canonical report input. `report.html` is generated only by the Data Analytics portable artifact builder. Validation and packaging passed; verification is `structural_only`. Exact payload equality, required runtime/reader roots, semantic fallback, 16 blocks, one chart, and four tables passed structural verification.

The configured Chromium executable did not exist, so browser verification could not start. The warning (`browser_unavailable`) and successful structural result are both preserved in `evidence/report-delivery-receipt.json`. Enhanced-reader chart SVG extraction, source-dialog interaction, and desktop/narrow viewport QA did not run; the generated semantic chart table remains available.

The report-specific Vitest passed 3/3 checks after validating the canonical decisions, all seven value-gate labels, unsupported-claim exclusions, rendered HTML, and the structural delivery receipt. The command receipt is `evidence/nco-report-test.log`. Two automated invocations that appended the prose labels `결과:` and `영수증:` as Vitest filters matched no files; they are invalid test evidence and are recorded separately in that receipt. The canonical command uses the explicit test-file path. The unrelated full nco suite is not presented as passing: 411/413 tests passed, with existing failures in `tests/근거.test.ts` (hard-coded date) and `src/core/smart-router.test.ts` (cost-order expectation).

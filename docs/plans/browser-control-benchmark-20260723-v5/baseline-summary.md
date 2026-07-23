# Browser-control port benchmark baseline

- Measured at: 2026-07-23T19:25:59+0900
- Host: arm64, Darwin 25.5.0
- Node: v25.9.0; npm: 11.12.1
- Repetitions: 3 (first=fresh-process cold; remaining=warm)
- Cache policy: dependency and OS caches retained; no privileged cache purge
- Statistics: warm arithmetic mean/min/max; throughput=warm runs / warm wall seconds
- Raw units: wall/user/sys seconds, CPU percent=(user+sys)/wall, max RSS KiB
- nova-use execution: isolated source mirror at `/private/tmp/nova-use-browser-bench.0gqvWh` with read-only dependency symlink
- cli-extensions build: isolated source mirror at `/private/tmp/cli-extension-browser-bench.N4Pd0e/extension` with read-only dependency symlink

## Source revisions

| Project | Commit SHA | Dirty tracked | Untracked |
|---|---|---:|---:|
| nco | `4adf31725bad1f44220d04952151c8197469f6e1` | 115 | 424 |
| nova-use | `408718d1739bcea747c3c863f75da5ac5a600446` | 67 | 158 |
| cli-extensions | `cff682d60e1e0579d0bc0bb32088ed2cef313b00` | 21 | 42 |

Dirty counts are captured to prevent confusing this working-tree baseline with a clean-commit result.

## Scenario commands

| Project | Scenario | Command | Regression-sensitive signal |
|---|---|---|---|
| nco | build-typecheck | `npm run build` | TypeScript errors, build latency, `dist/` size |
| nco | representative-tests | `npm run test:run -- tests/trajectory-guard.test.ts tests/response-quality.test.ts` | orchestration safety/response-quality pass rate |
| nova-use | build | `npm run build` | Electron main/preload/renderer build latency and `out/` size |
| nova-use | browser-port-tests | `npx vitest run --configLoader runner tests/agent-browser-adapter.spec.ts tests/browser.spec.ts tests/browser-consent.spec.ts tests/agent-control.spec.ts` | browser adapter, FORCE/CDP, consent, autonomous-control regressions |
| cli-extensions | extension-build | `(cd extension && npm run build)` | Chrome extension type/build regressions and `extension/dist/` size |
| cli-extensions | browser-contracts | `node tests/performance-contract.mjs && node tests/enhanced-snapshot-contract.mjs && node tests/action-surface.mjs && node tests/repeat-guard.mjs && node tests/shared-learning.mjs` | source capability, enhanced snapshot, repeat guard and learning contracts |

## Results

| Project | Scenario | Cold s | Warm mean s | Warm min/max s | Throughput runs/s | Success | Error | Mean CPU % | Peak RSS KiB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| nco | build-typecheck | 10.820 | 3.608 | 3.328/3.888 | 0.277 | 100.0% | 0.0% | 171.9 | 764064 |
| nco | representative-tests | 1.313 | 1.219 | 1.173/1.265 | 0.820 | 100.0% | 0.0% | 140.3 | 227968 |
| nova-use | build | 13.624 | 13.416 | 12.862/13.970 | 0.075 | 100.0% | 0.0% | 160.6 | 2780752 |
| nova-use | browser-port-tests | 3.113 | 1.356 | 1.291/1.422 | 0.737 | 100.0% | 0.0% | 296.6 | 165360 |
| cli-extensions | extension-build | 1.338 | 1.180 | 1.130/1.231 | 0.847 | 100.0% | 0.0% | 169.0 | 332304 |
| cli-extensions | browser-contracts | 0.581 | 0.480 | 0.434/0.527 | 2.082 | 100.0% | 0.0% | 18.8 | 54992 |

### Build artifact sizes

| Project | Artifact | KiB |
|---|---|---:|
| nco | `dist/` | 3720 |
| nova-use | `out/` | 27228 |
| cli-extensions | `extension/dist/` | 700 |

## T1 validation status

- `nco` build/typecheck gate: PASS in all 3 measured runs. See
  `logs/nco-build-typecheck-*.log` and matching `.time` files.
- `nova-use` build gate: PASS in all 3 isolated measured runs. See
  `logs/nova-use-build-*.log`.
- Browser-port focused regression gate: PASS in all 3 runs; each run reports
  4 files and 44 tests passed. See `logs/nova-use-browser-port-tests-*.log`.
- Full `nova-use` `npm test`: **FAIL**, so company-level T1 is not complete.
  The direct working-tree run captured earlier on 2026-07-23 reports 49/50
  files and 471/474 tests passing, with two `tests/nova-cli.spec.ts` failures:
  missing `computer drag` dispatch and command inventory 226/229.
- A second full-suite run in the managed isolated mirror is preserved as
  `t1-nova-use-test.log`. It reports 44/50 files and 462/474 tests passing;
  nine failures are caused by mirror/sandbox constraints (missing mirror
  `.git`/`tools`, denied loopback or nested `sandbox-exec`, and denied writes
  outside the writable roots), while the 226/229 command inventory mismatch
  reproduces independently.

## Interpretation and gates

- This run is a working-tree baseline, not a release benchmark; compare only against runs from the same host and protocol.
- Any non-zero exit, increased error rate, or missing build artifact is a hard regression.
- Latency/RSS alert threshold: >20% above this baseline on two consecutive same-protocol runs.
- Browser-port acceptance remains governed by the specification's full T1 suite; these focused scenarios are an early regression signal, not a substitute.
- Gate decision: benchmark baseline is usable, but the company-level T1 gate
  remains RED until the two direct working-tree `nova-cli` failures are fixed
  and the full suite is rerun in an environment that permits its integration
  tests.

## Raw evidence

- Machine-readable measurements: `raw.tsv`
- Per-run stdout: `logs/*.log`
- Per-run timing/RSS and stderr: `logs/*.time`
- Full-suite validation log: `t1-nova-use-test.log`
- Reproduction: `BENCH_REPETITIONS=3 BENCH_OUTPUT_DIR=<new-empty-path> scripts/run-benchmark.sh`

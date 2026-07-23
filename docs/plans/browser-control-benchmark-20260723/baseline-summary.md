# Browser-control port benchmark baseline

- Measured at: 2026-07-23T19:17:27+0900
- Host: arm64, Darwin 25.5.0
- Node: v25.9.0; npm: 11.12.1
- Repetitions: 3 (first=fresh-process cold; remaining=warm)
- Cache policy: dependency and OS caches retained; no privileged cache purge
- Statistics: warm arithmetic mean/min/max; throughput=warm runs / warm wall seconds
- Raw units: wall/user/sys seconds, CPU percent=(user+sys)/wall, max RSS KiB

## Source revisions

| Project | Commit SHA | Dirty tracked | Untracked |
|---|---|---:|---:|
| nco | `4adf31725bad1f44220d04952151c8197469f6e1` | 115 | 420 |
| nova-use | `408718d1739bcea747c3c863f75da5ac5a600446` | 67 | 158 |
| cli-extensions | `cff682d60e1e0579d0bc0bb32088ed2cef313b00` | 21 | 41 |

Dirty counts are captured to prevent confusing this working-tree baseline with a clean-commit result.

## Scenario commands

| Project | Scenario | Command | Regression-sensitive signal |
|---|---|---|---|
| nco | build-typecheck | `npm run build` | TypeScript errors, build latency, `dist/` size |
| nco | representative-tests | `npm run test:run -- tests/trajectory-guard.test.ts tests/response-quality.test.ts` | orchestration safety/response-quality pass rate |
| nova-use | build | `npm run build` | Electron main/preload/renderer build latency and `out/` size |
| nova-use | browser-port-tests | `npx vitest run tests/agent-browser-adapter.spec.ts tests/browser.spec.ts tests/browser-consent.spec.ts tests/agent-control.spec.ts` | browser adapter, FORCE/CDP, consent, autonomous-control regressions |
| cli-extensions | extension-build | `(cd extension && npm run build)` | Chrome extension type/build regressions and `extension/dist/` size |
| cli-extensions | browser-contracts | `node tests/performance-contract.mjs && node tests/enhanced-snapshot-contract.mjs && node tests/action-surface.mjs && node tests/repeat-guard.mjs && node tests/shared-learning.mjs` | source capability, enhanced snapshot, repeat guard and learning contracts |

## Results

| Project | Scenario | Cold s | Warm mean s | Warm min/max s | Throughput runs/s | Success | Error | Mean CPU % | Peak RSS KiB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| nco | build-typecheck | 3.280 | 2.870 | 2.830/2.910 | 0.348 | 0.0% | 100.0% | 193.1 | 0 |
| nco | representative-tests | 1.280 | 1.115 | 1.080/1.150 | 0.897 | 0.0% | 100.0% | 141.8 | 0 |
| nova-use | build | 0.330 | 0.320 | 0.320/0.320 | 3.125 | 0.0% | 100.0% | 107.8 | 0 |
| nova-use | browser-port-tests | 0.550 | 0.410 | 0.410/0.410 | 2.439 | 0.0% | 100.0% | 109.8 | 0 |
| cli-extensions | extension-build | 0.970 | 0.930 | 0.920/0.940 | 1.075 | 0.0% | 100.0% | 182.3 | 0 |
| cli-extensions | browser-contracts | 0.400 | 0.410 | 0.400/0.420 | 2.439 | 0.0% | 100.0% | 18.2 | 0 |

### Build artifact sizes

| Project | Artifact | KiB |
|---|---|---:|
| nco | `dist/` | 3720 |
| nova-use | `out/` | 27292 |
| cli-extensions | `extension/dist/` | 700 |

## Interpretation and gates

- This run is a working-tree baseline, not a release benchmark; compare only against runs from the same host and protocol.
- Any non-zero exit, increased error rate, or missing build artifact is a hard regression.
- Latency/RSS alert threshold: >20% above this baseline on two consecutive same-protocol runs.
- Browser-port acceptance remains governed by the specification's full T1 suite; these focused scenarios are an early regression signal, not a substitute.

## Raw evidence

- Machine-readable measurements: `raw.tsv`
- Per-run stdout: `logs/*.log`
- Per-run timing/RSS and stderr: `logs/*.time`
- Reproduction: `BENCH_REPETITIONS=3 BENCH_OUTPUT_DIR=<new-empty-path> scripts/run-benchmark.sh`

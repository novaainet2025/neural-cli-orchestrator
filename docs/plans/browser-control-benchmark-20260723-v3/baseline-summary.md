# Browser-control port benchmark baseline

- Measured at: 2026-07-23T19:22:29+0900
- Host: arm64, Darwin 25.5.0
- Node: v25.9.0; npm: 11.12.1
- Repetitions: 3 (first=fresh-process cold; remaining=warm)
- Cache policy: dependency and OS caches retained; no privileged cache purge
- Statistics: warm arithmetic mean/min/max; throughput=warm runs / warm wall seconds
- Raw units: wall/user/sys seconds, CPU percent=(user+sys)/wall, max RSS KiB
- nova-use execution: isolated source mirror at `/private/tmp/nova-use-browser-bench.YrjUuw` with read-only dependency symlink
- cli-extensions build: isolated source mirror at `/private/tmp/cli-extension-browser-bench.CHSEJo` with read-only dependency symlink

## Source revisions

| Project | Commit SHA | Dirty tracked | Untracked |
|---|---|---:|---:|
| nco | `4adf31725bad1f44220d04952151c8197469f6e1` | 115 | 421 |
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
| nco | build-typecheck | 3.086 | 3.050 | 3.023/3.078 | 0.328 | 100.0% | 0.0% | 188.9 | 752112 |
| nco | representative-tests | 1.074 | 1.143 | 1.111/1.174 | 0.875 | 100.0% | 0.0% | 143.1 | 224336 |
| nova-use | build | 11.842 | 12.190 | 12.161/12.219 | 0.082 | 100.0% | 0.0% | 171.1 | 2595984 |
| nova-use | browser-port-tests | 1.008 | 0.975 | 0.955/0.996 | 1.025 | 100.0% | 0.0% | 374.1 | 150016 |
| cli-extensions | extension-build | 1.023 | 0.870 | 0.853/0.888 | 1.149 | 0.0% | 100.0% | 186.9 | 337616 |
| cli-extensions | browser-contracts | 0.409 | 0.407 | 0.405/0.408 | 2.460 | 100.0% | 0.0% | 21.6 | 55104 |

### Build artifact sizes

| Project | Artifact | KiB |
|---|---|---:|
| nco | `dist/` | 3720 |
| nova-use | `out/` | 27228 |
| cli-extensions | `extension/dist/` | missing |

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

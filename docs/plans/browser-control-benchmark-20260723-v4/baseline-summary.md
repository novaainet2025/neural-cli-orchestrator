# Browser-control port benchmark baseline

- Measured at: 2026-07-23T19:24:19+0900
- Host: arm64, Darwin 25.5.0
- Node: v25.9.0; npm: 11.12.1
- Repetitions: 3 (first=fresh-process cold; remaining=warm)
- Cache policy: dependency and OS caches retained; no privileged cache purge
- Statistics: warm arithmetic mean/min/max; throughput=warm runs / warm wall seconds
- Raw units: wall/user/sys seconds, CPU percent=(user+sys)/wall, max RSS KiB
- nova-use execution: isolated source mirror at `/private/tmp/nova-use-browser-bench.lSKDYj` with read-only dependency symlink
- cli-extensions build: isolated source mirror at `/private/tmp/cli-extension-browser-bench.nEgosq/extension` with read-only dependency symlink

## Source revisions

| Project | Commit SHA | Dirty tracked | Untracked |
|---|---|---:|---:|
| nco | `4adf31725bad1f44220d04952151c8197469f6e1` | 115 | 422 |
| nova-use | `408718d1739bcea747c3c863f75da5ac5a600446` | 67 | 158 |
| cli-extensions | `cff682d60e1e0579d0bc0bb32088ed2cef313b00` | 21 | 43 |

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
| nco | build-typecheck | 9.296 | 2.972 | 2.913/3.032 | 0.336 | 100.0% | 0.0% | 191.2 | 762176 |
| nco | representative-tests | 1.107 | 1.872 | 1.790/1.953 | 0.534 | 100.0% | 0.0% | 110.0 | 224112 |
| nova-use | build | 25.857 | 13.160 | 12.564/13.757 | 0.076 | 100.0% | 0.0% | 165.4 | 2771936 |
| nova-use | browser-port-tests | 1.082 | 0.995 | 0.961/1.028 | 1.005 | 100.0% | 0.0% | 377.9 | 149120 |
| cli-extensions | extension-build | 1.112 | 1.152 | 1.146/1.158 | 0.868 | 0.0% | 100.0% | 165.7 | 332480 |
| cli-extensions | browser-contracts | 0.472 | 0.426 | 0.423/0.428 | 2.350 | 100.0% | 0.0% | 21.6 | 54960 |

### Build artifact sizes

| Project | Artifact | KiB |
|---|---|---:|
| nco | `dist/` | 3720 |
| nova-use | `out/` | 27228 |
| cli-extensions | `extension/dist/` | 660 |

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

# Browser-control P1-P4 isolated prototype A/B

- Measured at: 2026-07-23T10:27:33.243Z
- Host: darwin 25.5.0 arm64; Node v25.9.0
- Protocol: 7 fresh child processes per variant, 40,000 measured operations each
- Order control: baseline/candidate order alternated per repetition
- Isolation: prototype and evidence live under `nco`; `nova-use` and `cli-extensions` were read only
- Stage-04 reference: `docs/plans/browser-control-benchmark-20260723-v2/baseline-summary.md`

## Ground-truth source snapshot

| Source | Commit | Dirty rows | SHA-256 of inspected file |
|---|---|---:|---|
| nco | `4adf31725bad1f44220d04952151c8197469f6e1` | 540 | prototype source is in this evidence directory |
| nova-use adapter | `408718d1739bcea747c3c863f75da5ac5a600446` | 225 | `b5f7fe0871a213196ba96cf16ab8dd06299b2c7bf5b6fb039d151048fb706779` |
| cli-extensions page digest | `cff682d60e1e0579d0bc0bb32088ed2cef313b00` | 63 | `4348367b3947e156bf04a5091da50096acc737647a473d82cb4f81f42100291e` |
| cli-extensions force ladder | `cff682d60e1e0579d0bc0bb32088ed2cef313b00` | 63 | `8ab79ccc83c1fc5fff19b502a47e88d8462dea0412ad1e7817e2f40d80207741` |
| port specification | nova-use working tree | 225 | `3043947fa564d0424d45428858af0dc4ffeb5ee0a74baee439d0c287d7545593` |

Dirty-row counts and file hashes are recorded because all three repositories already had unrelated working-tree changes.

## A/B definition

| Variant | Behavior |
|---|---|
| Baseline | Frozen behavioral model of the currently inspected `nova-use::pageDigestFromSnapshot`; FORCE dispatch is accepted without target-effect proof; no learning store |
| Candidate | Existing sanitized `snapshot.refs` input plus P1 comprehension/affordances, bounded in-memory P2 fingerprint learning and repeat block, P3 target-effect verification/escalation, and P4 destructive/autostart gate |

The candidate is an adapter prototype, not production Electron code. It deliberately does not call `chrome.*`, does not persist data, and does not recreate nova-use ref/FORCE/CDP/deepInspect/capture/PolicyEngine.

## Results

| Metric | Baseline | Candidate | Candidate change |
|---|---:|---:|---:|
| P1-P4 feature coverage | 0/4 | 4/4 | +4 |
| Gap-contract fixture accuracy | 9.84% (6/61) | 100.00% (61/61) | 90.16 pp |
| Legacy digest parity | 100.00% | 100.00% | 0.00 pp |
| Overall contract accuracy | 55.65% | 100.00% | 44.35 pp |
| Mean latency | 1.67 µs/op | 5.65 µs/op | 238.90% |
| p50 latency | 1.64 µs/op | 5.64 µs/op | 244.36% |
| p95 latency | 1.79 µs/op | 5.79 µs/op | 223.98% |
| Mean throughput | 600989 ops/s | 177148 ops/s | -70.52% |
| Mean CPU | 2.07 µs/op | 7.30 µs/op | 252.87% |
| Peak process RSS | 55.91 MiB | 64.20 MiB | 14.84% |
| Runtime error rate | 0.00% (0/280000) | 0.00% (0/280000) | 0 errors |

## Gate decision

- Feature/accuracy: PASS — candidate improves the fixed P1-P4 contract fixture score.
- Legacy compatibility: PASS — candidate preserves all fields produced by the frozen shallow digest.
- Runtime errors: PASS — measured candidate operations must have zero exceptions.
- Performance alert (>20% latency or peak RSS): ALERT.

## Scope and limitations

- Accuracy means exact agreement with nine deterministic sanitized-ref fixtures and seven P2/P3 cross-cutting checks. It is not live-web semantic accuracy.
- Latency, throughput, CPU, and RSS are Node microbenchmark results. They do not include Electron WebContents, CDP attach/input, rendering, network, disk persistence, or consent latency.
- The Stage-04 repository build/test baseline uses a different scenario and must not be numerically merged with this table.
- P2 storage is intentionally in memory for isolation. Production migration must use nova-use `userData`, atomic bounded persistence, and existing policy/audit hooks.
- P3 models target-related effect evidence as fixture booleans. Production work still needs MutationObserver/URL/readback integration and CDP escalation tests in Electron.

## Reproduction and raw evidence

```bash
cd /Users/nova-ai/project/nco
node --test prototypes/browser-control-port/adapter.test.mjs
BROWSER_PORT_AB_REPETITIONS=7 BROWSER_PORT_AB_ITERATIONS=40000 \
  node prototypes/browser-control-port/run-benchmark.mjs
```

- Per-process raw rows: `raw.jsonl`
- Environment, revisions, and inspected-file hashes: `environment.json`

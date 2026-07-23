import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname, platform, arch, release } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '../..')
const outputDirectory = resolve(
  process.env.BROWSER_PORT_AB_OUTPUT ?? resolve(workspace, 'docs/plans/browser-control-port-ab-20260723'),
)
const repetitions = Number.parseInt(process.env.BROWSER_PORT_AB_REPETITIONS ?? '7', 10)
const iterations = Number.parseInt(process.env.BROWSER_PORT_AB_ITERATIONS ?? '40000', 10)
if (!Number.isInteger(repetitions) || repetitions < 3 || !Number.isInteger(iterations) || iterations < 1_000) {
  throw new Error('repetitions must be >=3 and iterations must be >=1000')
}

const sourcePaths = {
  spec: '/Users/nova-ai/project/nova-use/docs/plans/browser-control-extension-port.md',
  novaUseAdapter: '/Users/nova-ai/project/nova-use/src/main/agent-browser-adapter.ts',
  originalPageDigest: '/Users/nova-ai/project/크롬확장프로그램/cli-extensions/extension/src/content/page-digest.ts',
  originalForce: '/Users/nova-ai/project/크롬확장프로그램/cli-extensions/extension/src/content/force.ts',
  originalDestructive: '/Users/nova-ai/project/크롬확장프로그램/cli-extensions/extension/src/shared/destructive.ts',
}

const gitInfo = (path) => {
  const sha = execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['-C', path, 'status', '--porcelain'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  return { sha, dirtyRows: status.length }
}

const hashFile = async (path) =>
  createHash('sha256').update(await readFile(path)).digest('hex')

const runWorker = (variant) => new Promise((resolvePromise, rejectPromise) => {
  const child = spawn(process.execPath, [resolve(here, 'benchmark-worker.mjs'), variant, String(iterations)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.once('error', rejectPromise)
  child.once('close', (code) => {
    if (code !== 0) {
      rejectPromise(new Error(`worker ${variant} exited ${code}: ${stderr}`))
      return
    }
    try {
      resolvePromise(JSON.parse(stdout))
    } catch (error) {
      rejectPromise(new Error(`worker ${variant} emitted invalid JSON: ${error}\n${stdout}\n${stderr}`))
    }
  })
})

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
const percentile = (values, fraction) => {
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}
const percent = (value) => `${(value * 100).toFixed(2)}%`
const number = (value, digits = 2) => value.toFixed(digits)
const delta = (baseline, candidate) => (candidate - baseline) / baseline

await mkdir(outputDirectory, { recursive: true })

const sources = {}
for (const [name, path] of Object.entries(sourcePaths)) {
  sources[name] = { path, sha256: await hashFile(path) }
}
const environment = {
  measuredAt: new Date().toISOString(),
  host: hostname(),
  platform: `${platform()} ${release()} ${arch()}`,
  node: process.version,
  repetitions,
  iterationsPerRepetition: iterations,
  sourceRepositories: {
    nco: gitInfo(workspace),
    novaUse: gitInfo('/Users/nova-ai/project/nova-use'),
    cliExtensions: gitInfo('/Users/nova-ai/project/크롬확장프로그램/cli-extensions'),
  },
  sources,
}

const rows = []
for (let repetition = 1; repetition <= repetitions; repetition += 1) {
  const order = repetition % 2 === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
  for (const variant of order) {
    rows.push({ repetition, measuredAt: new Date().toISOString(), ...await runWorker(variant) })
  }
}

const byVariant = Object.fromEntries(['baseline', 'candidate'].map((variant) => {
  const selected = rows.filter((row) => row.variant === variant)
  return [variant, {
    latencyMean: mean(selected.map((row) => row.latencyUsPerOperation)),
    latencyP50: percentile(selected.map((row) => row.latencyUsPerOperation), 0.5),
    latencyP95: percentile(selected.map((row) => row.latencyUsPerOperation), 0.95),
    throughputMean: mean(selected.map((row) => row.throughputOperationsPerSecond)),
    cpuMean: mean(selected.map((row) => row.cpuUsPerOperation)),
    rssPeak: Math.max(...selected.map((row) => row.maxRssKiB)),
    errors: selected.reduce((sum, row) => sum + row.errors, 0),
    operations: selected.reduce((sum, row) => sum + row.iterations, 0),
    accuracy: selected[0].accuracy,
  }]
}))

const baseline = byVariant.baseline
const candidate = byVariant.candidate
const coverage = (value) => Object.values(value).filter(Boolean).length
const latencyDelta = delta(baseline.latencyMean, candidate.latencyMean)
const throughputDelta = delta(baseline.throughputMean, candidate.throughputMean)
const cpuDelta = delta(baseline.cpuMean, candidate.cpuMean)
const rssDelta = delta(baseline.rssPeak, candidate.rssPeak)
const gapAccuracy = (value) => value.gapPassed / value.gapTotal
const overallAccuracy = (value) => value.overallPassed / value.overallTotal
const legacyAccuracy = (value) => value.legacyPassed / value.legacyTotal
const performanceAlert = latencyDelta > 0.2 || rssDelta > 0.2

const report = `# Browser-control P1-P4 isolated prototype A/B

- Measured at: ${environment.measuredAt}
- Host: ${environment.platform}; Node ${environment.node}
- Protocol: ${repetitions} fresh child processes per variant, ${iterations.toLocaleString('en-US')} measured operations each
- Order control: baseline/candidate order alternated per repetition
- Isolation: prototype and evidence live under \`nco\`; \`nova-use\` and \`cli-extensions\` were read only
- Stage-04 reference: \`docs/plans/browser-control-benchmark-20260723-v2/baseline-summary.md\`

## Ground-truth source snapshot

| Source | Commit | Dirty rows | SHA-256 of inspected file |
|---|---|---:|---|
| nco | \`${environment.sourceRepositories.nco.sha}\` | ${environment.sourceRepositories.nco.dirtyRows} | prototype source is in this evidence directory |
| nova-use adapter | \`${environment.sourceRepositories.novaUse.sha}\` | ${environment.sourceRepositories.novaUse.dirtyRows} | \`${sources.novaUseAdapter.sha256}\` |
| cli-extensions page digest | \`${environment.sourceRepositories.cliExtensions.sha}\` | ${environment.sourceRepositories.cliExtensions.dirtyRows} | \`${sources.originalPageDigest.sha256}\` |
| cli-extensions force ladder | \`${environment.sourceRepositories.cliExtensions.sha}\` | ${environment.sourceRepositories.cliExtensions.dirtyRows} | \`${sources.originalForce.sha256}\` |
| port specification | nova-use working tree | ${environment.sourceRepositories.novaUse.dirtyRows} | \`${sources.spec.sha256}\` |

Dirty-row counts and file hashes are recorded because all three repositories already had unrelated working-tree changes.

## A/B definition

| Variant | Behavior |
|---|---|
| Baseline | Frozen behavioral model of the currently inspected \`nova-use::pageDigestFromSnapshot\`; FORCE dispatch is accepted without target-effect proof; no learning store |
| Candidate | Existing sanitized \`snapshot.refs\` input plus P1 comprehension/affordances, bounded in-memory P2 fingerprint learning and repeat block, P3 target-effect verification/escalation, and P4 destructive/autostart gate |

The candidate is an adapter prototype, not production Electron code. It deliberately does not call \`chrome.*\`, does not persist data, and does not recreate nova-use ref/FORCE/CDP/deepInspect/capture/PolicyEngine.

## Results

| Metric | Baseline | Candidate | Candidate change |
|---|---:|---:|---:|
| P1-P4 feature coverage | ${coverage(baseline.accuracy.featureCoverage)}/4 | ${coverage(candidate.accuracy.featureCoverage)}/4 | +${coverage(candidate.accuracy.featureCoverage) - coverage(baseline.accuracy.featureCoverage)} |
| Gap-contract fixture accuracy | ${percent(gapAccuracy(baseline.accuracy))} (${baseline.accuracy.gapPassed}/${baseline.accuracy.gapTotal}) | ${percent(gapAccuracy(candidate.accuracy))} (${candidate.accuracy.gapPassed}/${candidate.accuracy.gapTotal}) | ${number((gapAccuracy(candidate.accuracy) - gapAccuracy(baseline.accuracy)) * 100)} pp |
| Legacy digest parity | ${percent(legacyAccuracy(baseline.accuracy))} | ${percent(legacyAccuracy(candidate.accuracy))} | ${number((legacyAccuracy(candidate.accuracy) - legacyAccuracy(baseline.accuracy)) * 100)} pp |
| Overall contract accuracy | ${percent(overallAccuracy(baseline.accuracy))} | ${percent(overallAccuracy(candidate.accuracy))} | ${number((overallAccuracy(candidate.accuracy) - overallAccuracy(baseline.accuracy)) * 100)} pp |
| Mean latency | ${number(baseline.latencyMean)} µs/op | ${number(candidate.latencyMean)} µs/op | ${percent(latencyDelta)} |
| p50 latency | ${number(baseline.latencyP50)} µs/op | ${number(candidate.latencyP50)} µs/op | ${percent(delta(baseline.latencyP50, candidate.latencyP50))} |
| p95 latency | ${number(baseline.latencyP95)} µs/op | ${number(candidate.latencyP95)} µs/op | ${percent(delta(baseline.latencyP95, candidate.latencyP95))} |
| Mean throughput | ${number(baseline.throughputMean, 0)} ops/s | ${number(candidate.throughputMean, 0)} ops/s | ${percent(throughputDelta)} |
| Mean CPU | ${number(baseline.cpuMean)} µs/op | ${number(candidate.cpuMean)} µs/op | ${percent(cpuDelta)} |
| Peak process RSS | ${number(baseline.rssPeak / 1024)} MiB | ${number(candidate.rssPeak / 1024)} MiB | ${percent(rssDelta)} |
| Runtime error rate | ${percent(baseline.errors / baseline.operations)} (${baseline.errors}/${baseline.operations}) | ${percent(candidate.errors / candidate.operations)} (${candidate.errors}/${candidate.operations}) | ${candidate.errors - baseline.errors} errors |

## Gate decision

- Feature/accuracy: ${gapAccuracy(candidate.accuracy) > gapAccuracy(baseline.accuracy) ? 'PASS' : 'FAIL'} — candidate improves the fixed P1-P4 contract fixture score.
- Legacy compatibility: ${legacyAccuracy(candidate.accuracy) === 1 ? 'PASS' : 'FAIL'} — candidate preserves all fields produced by the frozen shallow digest.
- Runtime errors: ${candidate.errors === 0 ? 'PASS' : 'FAIL'} — measured candidate operations must have zero exceptions.
- Performance alert (>20% latency or peak RSS): ${performanceAlert ? 'ALERT' : 'PASS'}.

## Scope and limitations

- Accuracy means exact agreement with nine deterministic sanitized-ref fixtures and seven P2/P3 cross-cutting checks. It is not live-web semantic accuracy.
- Latency, throughput, CPU, and RSS are Node microbenchmark results. They do not include Electron WebContents, CDP attach/input, rendering, network, disk persistence, or consent latency.
- The Stage-04 repository build/test baseline uses a different scenario and must not be numerically merged with this table.
- P2 storage is intentionally in memory for isolation. Production migration must use nova-use \`userData\`, atomic bounded persistence, and existing policy/audit hooks.
- P3 models target-related effect evidence as fixture booleans. Production work still needs MutationObserver/URL/readback integration and CDP escalation tests in Electron.

## Reproduction and raw evidence

\`\`\`bash
cd ${workspace}
node --test prototypes/browser-control-port/adapter.test.mjs
BROWSER_PORT_AB_REPETITIONS=${repetitions} BROWSER_PORT_AB_ITERATIONS=${iterations} \\
  node prototypes/browser-control-port/run-benchmark.mjs
\`\`\`

- Per-process raw rows: \`raw.jsonl\`
- Environment, revisions, and inspected-file hashes: \`environment.json\`
`

await Promise.all([
  writeFile(resolve(outputDirectory, 'raw.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`),
  writeFile(resolve(outputDirectory, 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`),
  writeFile(resolve(outputDirectory, 'ab-summary.md'), report),
])

process.stdout.write(`${report}\nEvidence written to ${outputDirectory}\n`)

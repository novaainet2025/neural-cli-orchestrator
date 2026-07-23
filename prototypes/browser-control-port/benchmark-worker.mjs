import {
  LearningPrototype,
  baselineDigest,
  baselineForceLadder,
  candidateDigest,
  candidateForceLadder,
} from './adapter.mjs'
import { fixtures } from './fixtures.mjs'

const variant = process.argv[2]
const iterations = Number.parseInt(process.argv[3] ?? '40000', 10)
if (!['baseline', 'candidate'].includes(variant) || !Number.isInteger(iterations) || iterations < 1) {
  throw new Error('usage: node benchmark-worker.mjs <baseline|candidate> <positive-iterations>')
}

const digestFor = variant === 'candidate' ? candidateDigest : baselineDigest
const forceFor = variant === 'candidate' ? candidateForceLadder : baselineForceLadder

function accuracy() {
  let legacyPassed = 0
  let legacyTotal = 0
  let gapPassed = 0
  let gapTotal = 0

  for (const fixture of fixtures) {
    const baseline = baselineDigest(fixture.snapshot)
    const digest = digestFor(fixture.snapshot)
    for (const key of ['title', 'url', 'counts', 'purpose', 'progress', 'nextAction', 'fields']) {
      legacyTotal += 1
      if (JSON.stringify(digest[key]) === JSON.stringify(baseline[key])) legacyPassed += 1
    }

    const comprehension = digest.comprehension
    const destructive = (digest.affordances ?? [])
      .filter((item) => item.destructive)
      .map((item) => item.ref)
      .sort()
    const checks = [
      comprehension?.taskType === fixture.expected.taskType,
      (comprehension?.primaryCta?.selector ?? null) === fixture.expected.primary,
      JSON.stringify(destructive) === JSON.stringify(fixture.expected.destructive.toSorted()),
      comprehension?.safeToAutostart === fixture.expected.safeToAutostart,
      Array.isArray(comprehension?.playbook) && comprehension.playbook.length > 0,
      typeof comprehension?.autoMission === 'string' && comprehension.autoMission.length > 0,
    ]
    gapTotal += checks.length
    gapPassed += checks.filter(Boolean).length
  }

  const learning = variant === 'candidate' ? new LearningPrototype() : null
  if (learning) {
    learning.recordAction({
      pageSignature: 'search-page',
      action: 'CLICK',
      domain: 'https://docs.example.com/search',
      selector: '@search',
      success: true,
      strategy: 'ref',
    })
    learning.recordAction({
      pageSignature: 'stale-page',
      action: 'CLICK',
      domain: 'https://docs.example.com/search',
      selector: '@stale',
      success: false,
      strategy: 'dom',
    })
    learning.lesson({ domain: 'docs.example.com', goal: 'search', note: 'Use the stable ref' })
    learning.done({ domain: 'docs.example.com', goal: 'search', evidence: 'results heading visible' })
  }
  const recall = learning?.recall('search', 'docs.example.com')
  const noEffect = forceFor([
    { strategy: 'native-click', dispatched: true, targetEffect: false },
    { strategy: 'synthetic-events', dispatched: true, targetEffect: false },
  ])
  const withEffect = forceFor([
    { strategy: 'native-click', dispatched: true, targetEffect: false },
    { strategy: 'synthetic-events', dispatched: true, targetEffect: true },
  ])
  const crossCuttingChecks = [
    recall?.successfulRoutines.length === 1,
    recall?.failures.length === 1,
    recall?.lessons.length === 1,
    recall?.completions.length === 1,
    learning?.isRepeatedFailure({
      pageSignature: 'stale-page',
      action: 'CLICK',
      selector: '@stale',
    }) === true,
    noEffect.ok === false && noEffect.escalate === 'cdp' && noEffect.verified === false,
    withEffect.ok === true && withEffect.verified === true,
  ]
  gapTotal += crossCuttingChecks.length
  gapPassed += crossCuttingChecks.filter(Boolean).length

  return {
    legacyPassed,
    legacyTotal,
    gapPassed,
    gapTotal,
    overallPassed: legacyPassed + gapPassed,
    overallTotal: legacyTotal + gapTotal,
    featureCoverage: {
      P1: variant === 'candidate' && gapPassed >= fixtures.length * 6,
      P2: Boolean(recall?.successfulRoutines.length === 1 && crossCuttingChecks[4]),
      P3: Boolean(crossCuttingChecks[5] && crossCuttingChecks[6]),
      P4: variant === 'candidate' && fixtures
        .filter((fixture) => fixture.expected.destructive.length > 0)
        .every((fixture) => {
          const digest = digestFor(fixture.snapshot)
          return digest.affordances?.some((item) => item.destructive)
            && digest.comprehension?.safeToAutostart === fixture.expected.safeToAutostart
        }),
    },
  }
}

function exercise(count) {
  const learning = variant === 'candidate' ? new LearningPrototype() : null
  let errors = 0
  let checksum = 0
  const beforeCpu = process.cpuUsage()
  const beforeMemory = process.memoryUsage().rss
  const started = process.hrtime.bigint()

  for (let index = 0; index < count; index += 1) {
    try {
      const fixture = fixtures[index % fixtures.length]
      const digest = digestFor(fixture.snapshot)
      if (learning && index % 64 === 0) {
        learning.recordAction({
          pageSignature: fixture.id,
          action: 'CLICK',
          domain: fixture.snapshot.url,
          selector: fixture.expected.primary ?? '@none',
          success: index % 128 === 0,
          strategy: 'ref',
        })
      }
      const blocked = learning?.isRepeatedFailure({
        pageSignature: fixture.id,
        action: 'CLICK',
        selector: fixture.expected.primary ?? '@none',
      }) ?? false
      const force = forceFor([
        { strategy: 'native-click', dispatched: true, targetEffect: false },
        { strategy: 'synthetic-events', dispatched: true, targetEffect: index % 3 === 0 },
      ])
      checksum += JSON.stringify(digest).length + force.tried.length + Number(blocked)
    } catch {
      errors += 1
    }
  }

  const elapsedNs = Number(process.hrtime.bigint() - started)
  const cpu = process.cpuUsage(beforeCpu)
  const afterMemory = process.memoryUsage().rss
  return {
    elapsedNs,
    latencyUsPerOperation: elapsedNs / count / 1_000,
    throughputOperationsPerSecond: count / (elapsedNs / 1_000_000_000),
    cpuUsPerOperation: (cpu.user + cpu.system) / count,
    rssBeforeKiB: beforeMemory / 1024,
    rssAfterKiB: afterMemory / 1024,
    maxRssKiB: process.resourceUsage().maxRSS,
    errors,
    errorRate: errors / count,
    checksum,
  }
}

exercise(Math.min(iterations, 2_000))
const result = exercise(iterations)
process.stdout.write(`${JSON.stringify({
  variant,
  iterations,
  ...result,
  accuracy: accuracy(),
})}\n`)

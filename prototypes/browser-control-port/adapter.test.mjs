import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LearningPrototype,
  baselineDigest,
  candidateDigest,
  candidateForceLadder,
} from './adapter.mjs'
import { fixtures } from './fixtures.mjs'

test('candidate preserves every existing shallow digest field', () => {
  for (const fixture of fixtures) {
    const baseline = baselineDigest(fixture.snapshot)
    const candidate = candidateDigest(fixture.snapshot)
    for (const key of ['title', 'url', 'counts', 'purpose', 'progress', 'nextAction', 'fields']) {
      assert.deepEqual(candidate[key], baseline[key], `${fixture.id}: ${key}`)
    }
  }
})

test('candidate fills comprehension and affordance contracts for all fixtures', () => {
  for (const fixture of fixtures) {
    const digest = candidateDigest(fixture.snapshot)
    assert.equal(digest.comprehension.taskType, fixture.expected.taskType, fixture.id)
    assert.equal(digest.comprehension.primaryCta?.selector ?? null, fixture.expected.primary, fixture.id)
    assert.equal(digest.comprehension.safeToAutostart, fixture.expected.safeToAutostart, fixture.id)
    assert.ok(digest.comprehension.playbook.length > 0, fixture.id)
    assert.ok(digest.comprehension.autoMission.length > 0, fixture.id)
    assert.deepEqual(
      digest.affordances.filter((item) => item.destructive).map((item) => item.ref).sort(),
      fixture.expected.destructive.toSorted(),
      fixture.id,
    )
  }
})

test('learning recalls success and blocks an identical failed fingerprint', () => {
  const learning = new LearningPrototype()
  learning.recordAction({
    pageSignature: 'page-a',
    action: 'CLICK',
    domain: 'https://docs.example.com/path',
    selector: '@search',
    success: true,
    strategy: 'ref',
  })
  learning.recordAction({
    pageSignature: 'page-b',
    action: 'CLICK',
    domain: 'https://docs.example.com/path',
    selector: '@stale',
    success: false,
    strategy: 'dom',
  })

  assert.equal(learning.recall('search docs', 'docs.example.com').successfulRoutines.length, 1)
  assert.equal(learning.isRepeatedFailure({
    pageSignature: 'page-b',
    action: 'CLICK',
    selector: '@stale',
  }), true)
  assert.equal(learning.isRepeatedFailure({
    pageSignature: 'page-b',
    action: 'CLICK',
    selector: '@different',
  }), false)
})

test('learning masks secrets, records lesson/done, and enforces the 500 row cap', () => {
  const learning = new LearningPrototype()
  const lesson = learning.lesson({
    domain: 'https://example.com',
    goal: 'contact user@example.com',
    note: 'api_key=secret-value',
  })
  const completion = learning.done({
    domain: 'https://example.com',
    goal: 'publish',
    evidence: 'sk-proj-abcdefghijk',
  })
  const action = learning.recordAction({
    pageSignature: 'page-sensitive',
    action: 'TYPE',
    domain: 'https://example.com',
    selector: '#user@example.com',
    success: true,
  })

  assert.equal(lesson.goal, 'contact <email>')
  assert.equal(lesson.note, 'api_key=<secret>')
  assert.equal(completion.evidence, '<api-key>')
  assert.equal(action.selector, '#<email>')

  for (let index = 0; index < 501; index += 1) {
    learning.recordAction({
      pageSignature: `page-${index}`,
      action: 'TYPE',
      domain: 'https://example.com',
      selector: `#user-${index}@example.com`,
      success: index % 2 === 0,
    })
  }

  assert.equal(learning.records.length, 500)
})

test('force ladder accepts only a target-related effect and otherwise escalates', () => {
  assert.deepEqual(
    candidateForceLadder([
      { strategy: 'native-click', dispatched: true, targetEffect: false },
      { strategy: 'synthetic-events', dispatched: true, targetEffect: false },
    ]),
    {
      ok: false,
      tried: ['native-click', 'synthetic-events'],
      verified: false,
      escalate: 'cdp',
      error: 'no_effect_after_dom_ladder',
    },
  )
  assert.deepEqual(
    candidateForceLadder([
      { strategy: 'native-click', dispatched: true, targetEffect: false },
      { strategy: 'synthetic-events', dispatched: true, targetEffect: true },
    ]),
    {
      ok: true,
      tried: ['native-click', 'synthetic-events'],
      strategy: 'synthetic-events',
      verified: true,
    },
  )
})

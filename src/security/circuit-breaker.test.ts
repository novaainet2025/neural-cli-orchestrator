import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const learnedPattern = vi.hoisted(() => ({
  signature: null as string | null,
}));

vi.mock('../storage/database.js', () => ({
  getDb: () => { throw new Error('database unavailable in unit test'); },
}));
vi.mock('../core/failure-learning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/failure-learning.js')>();
  return {
    ...actual,
    matchLearnedCircuitPattern: vi.fn((raw: string | null | undefined) => {
      const signature = raw?.trim();
      if (!learnedPattern.signature || signature !== learnedPattern.signature) {
        return actual.matchLearnedCircuitPattern(raw);
      }
      return {
        signature,
        sourceCount: 3,
        firstSeen: '2026-01-01 00:00:00',
        lastSeen: '2026-01-01 00:00:00',
        regex: new RegExp(`^${signature}$`, 'u'),
        reason: 'generic',
        immediateOpen: false,
        failureThreshold: 2,
      };
    }),
  };
});
vi.mock('../core/shared-state.js', () => ({
  sharedState: { setAgentState: vi.fn(async () => undefined) },
}));
vi.mock('../core/event-bus.js', () => ({
  eventBus: { publish: vi.fn(async () => undefined) },
}));
vi.mock('../core/decision-log.js', () => ({ logDecision: vi.fn() }));
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { CircuitBreaker } from './circuit-breaker.js';
import {
  circuitBreakerRegistry,
  classifyCircuitError,
  classifyProviderErrorEnvelope,
  stripCommandEcho,
} from './circuit-breaker-registry.js';

describe('CircuitBreaker configuration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    learnedPattern.signature = null;
  });

  afterEach(() => {
    learnedPattern.signature = null;
    vi.useRealTimers();
  });

  it('uses the configured threshold, reset timeout, and half-open attempt cap', () => {
    const breaker = new CircuitBreaker('configured-test', {
      failureThreshold: 2,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    breaker.reset();

    breaker.recordFailure('first');
    expect(breaker.getState()).toBe('closed');
    breaker.recordFailure('second');
    expect(breaker.getState()).toBe('open');
    expect(breaker.canExecute()).toBe(false);

    vi.advanceTimersByTime(50);
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.getState()).toBe('half-open');
    expect(breaker.canExecute()).toBe(false);

    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
  });

  it('opens on the second exact learned failure without immediate-opening on the first', () => {
    const signature = 'repeated exact transient failure';
    learnedPattern.signature = signature;
    const breaker = new CircuitBreaker('learned-threshold-test', {
      failureThreshold: 3,
    });
    breaker.reset();

    breaker.recordFailure(signature);
    expect(breaker.getState()).toBe('closed');
    expect(breaker.getFailures()).toBe(1);

    breaker.recordFailure(signature);
    expect(breaker.getState()).toBe('open');
    expect(circuitBreakerRegistry.getSnapshot('learned-threshold-test').reason).toBe('generic');
  });

  it('keeps the actual weekly-limit failure gated until the next Seoul reset', () => {
    vi.setSystemTime(new Date('2026-07-28T05:39:39.000Z'));
    const agentId = 'weekly-limit-seoul-reset-test';
    const error = "subprocess exited with code 1: You've hit your weekly limit · resets 4am (Asia/Seoul)";

    const classified = classifyCircuitError(error);
    expect(classified).toMatchObject({
      reason: 'quota',
      immediateOpen: true,
      resetTime: Date.parse('2026-07-28T19:00:00.000Z'),
    });

    circuitBreakerRegistry.reset(agentId);
    circuitBreakerRegistry.recordFailure(agentId, error);
    expect(circuitBreakerRegistry.getSnapshot(agentId)).toMatchObject({
      state: 'open',
      reason: 'quota',
      cooldownUntil: Date.parse('2026-07-28T19:00:00.000Z'),
    });
  });

  it('classifies the actual provider queue timeout as an immediate rate-limit gate', () => {
    expect(classifyCircuitError(
      'queue_wait_timeout: provider claude-code busy for 1800000ms',
    )).toMatchObject({
      reason: 'rate-limit',
      immediateOpen: true,
    });
  });

  // P0-3: halfOpenAttempts는 누적 카운터가 아니라 in-flight 세마포어다. 슬롯을 획득한
  // 실행이 끝나면 releaseProbeSlot()으로 반드시 반납해야, 그 세션이 끝난 뒤 새 프로브가
  // 진행될 수 있다 — 반납 누락이 half-open 영구 고착의 근본 원인이었다.
  it('releases the held half-open probe slot so a subsequent probe can proceed', () => {
    const breaker = new CircuitBreaker('probe-slot-release-test', {
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    breaker.reset();

    breaker.recordFailure('boom');
    expect(breaker.getState()).toBe('open');

    vi.advanceTimersByTime(50);
    expect(breaker.canExecute()).toBe(true); // 유일한 프로브 슬롯 획득
    expect(breaker.getState()).toBe('half-open');
    expect(breaker.canExecute()).toBe(false); // 슬롯이 이미 점유됨 — 두 번째 동시 프로브 불가

    circuitBreakerRegistry.releaseProbeSlot('probe-slot-release-test');
    expect(breaker.canExecute()).toBe(true); // 반납 후 새 프로브 진행 가능
  });

  // 반납 위치를 잘못 잡으면(획득하지 않은 경로에서 반납) 카운터가 음수로 내려가 canExecute()가
  // 무제한으로 true를 반환할 위험이 있다 — releaseProbeSlot()은 held slot이 없을 때 no-op이어야
  // 하고, in-flight 한도(halfOpenMaxAttempts)는 그대로 유지되어야 한다.
  it('does not underflow when releasing a slot that was never acquired', () => {
    const breaker = new CircuitBreaker('probe-slot-unheld-test', {
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    breaker.reset();

    circuitBreakerRegistry.releaseProbeSlot('probe-slot-unheld-test'); // no-op, must not underflow

    breaker.recordFailure('boom');
    vi.advanceTimersByTime(50);
    expect(breaker.canExecute()).toBe(true); // 여전히 정확히 1개 슬롯만 허용
    expect(breaker.canExecute()).toBe(false); // 한도 초과 — 무제한 동시 실행 아님
  });

  it('starts the half-open TTL when the probe state begins, not when the circuit first opened', () => {
    const breaker = new CircuitBreaker('probe-ttl-start-test', {
      failureThreshold: 1,
      resetTimeoutMs: 10 * 60_000,
      halfOpenMaxAttempts: 1,
    });
    breaker.reset();

    breaker.recordFailure('boom');
    vi.advanceTimersByTime(10 * 60_000);
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.getState()).toBe('half-open');
  });

  // Regression test for A (half-open probe slot): getSnapshot() is a
  // non-mutating observer that must NOT consume a probe slot. Only
  // canExecute() should consume it. Without this guard, a nested
  // getSnapshot() call inside the probe execution would starve the
  // sole half-open slot and prevent circuit recovery.
  it('getSnapshot() does not consume the half-open probe slot', () => {
    const breaker = new CircuitBreaker('half-open-slot-test', {
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    breaker.reset();

    breaker.recordFailure('boom');
    expect(breaker.getState()).toBe('open');

    vi.advanceTimersByTime(50);

    // Acquire the sole probe slot — first canExecute() returns true
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.getState()).toBe('half-open');

    // getSnapshot() (simulating nested observation) must NOT consume a slot
    // Second canExecute() must still return false
    expect(breaker.getState()).toBe('half-open'); // observation, no slot consumed
    expect(breaker.canExecute()).toBe(false); // slot still held

    // Release the probe slot
    circuitBreakerRegistry.releaseProbeSlot('half-open-slot-test');
    expect(breaker.canExecute()).toBe(true); // new probe can proceed
  });

  it('keeps a live probe half-open past TTL and rejects a second probe', () => {
    const breaker = new CircuitBreaker('live-probe-ttl-test', {
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    const controller = new AbortController();
    breaker.reset();
    breaker.recordFailure('boom');
    vi.advanceTimersByTime(50);

    expect(breaker.canExecute()).toBe(true);
    expect(circuitBreakerRegistry.bindProbeSlot(
      'live-probe-ttl-test',
      controller.signal,
    )).toBe(true);

    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(breaker.getState()).toBe('half-open');
    expect(breaker.canExecute()).toBe(false);

    controller.abort();
    expect(breaker.getState()).toBe('half-open');
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.canExecute()).toBe(false);
  });

  it('reclaims an abandoned half-open slot without allowing a retry burst', () => {
    const breaker = new CircuitBreaker('abandoned-probe-ttl-test', {
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    breaker.reset();
    breaker.recordFailure('boom');
    vi.advanceTimersByTime(50);

    expect(breaker.canExecute()).toBe(true);
    expect(breaker.getState()).toBe('half-open');

    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(breaker.getState()).toBe('half-open');
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.canExecute()).toBe(false);
  });

  it('does not let an observer clear a slot acquired from an expired half-open circuit', () => {
    const breaker = new CircuitBreaker('expired-half-open-interleave-test', {
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
    const controller = new AbortController();
    breaker.reset();
    breaker.recordFailure('boom');
    vi.advanceTimersByTime(50);

    expect(breaker.canExecute()).toBe(true);
    vi.advanceTimersByTime(5 * 60_000 + 1);

    // canExecute() must reclaim first, then acquire. A subsequent observer
    // must not delete that just-acquired attempt before it is signal-bound.
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.getState()).toBe('half-open');
    expect(circuitBreakerRegistry.bindProbeSlot(
      'expired-half-open-interleave-test',
      controller.signal,
    )).toBe(true);
    expect(breaker.canExecute()).toBe(false);
  });

  it('recoverAll makes expired open circuits probe-ready without closing them', () => {
    const breaker1 = new CircuitBreaker('recover-a', {
      failureThreshold: 1,
      resetTimeoutMs: 50,
    });
    breaker1.reset();

    breaker1.recordFailure('drop');
    expect(breaker1.getState()).toBe('open');

    // Before cooldown: recoverAll keeps open circuits intact
    let r = circuitBreakerRegistry.recoverAll();
    expect(r.recovered).toBeGreaterThanOrEqual(0);
    expect(r.open).toBeGreaterThanOrEqual(1);
    expect(breaker1.getState()).toBe('open');

    // Advance past cooldown (50ms)
    vi.advanceTimersByTime(50);
    r = circuitBreakerRegistry.recoverAll();
    expect(r.recovered).toBeGreaterThanOrEqual(1);
    expect(breaker1.getState()).toBe('half-open');
    expect(breaker1.canExecute()).toBe(true);
    expect(breaker1.canExecute()).toBe(false);
    breaker1.recordSuccess();
    expect(breaker1.getState()).toBe('closed');
  });
});

// GATE-LEARN-R1 (cycle 2에서 배선, cycle 3 중복에러방지팀이 테스트 보강).
// 픽스처는 실제 DB 행 task_p2V_WOaQg3z-gdGx / task_KkeE7Ly_A5hC1K2n의 tasks.response 형태다.
describe('classifyProviderErrorEnvelope (NCO_CB_ERROR_ENVELOPE)', () => {
  const realAuthEnvelope = JSON.stringify({
    type: 'error',
    timestamp: 1785173399807,
    sessionID: 'ses_05b5fab79ffeyLgd5ir8tajWDO',
    error: {
      name: 'APIError',
      data: {
        message: 'invalid x-api-key',
        statusCode: 401,
        isRetryable: false,
        responseHeaders: { server: 'cloudflare', 'content-type': 'application/json' },
      },
    },
  });

  it('classifies a real hard-401 provider envelope as immediate open with reason=generic', () => {
    const result = classifyProviderErrorEnvelope(realAuthEnvelope, 'on');
    expect(result).not.toBeNull();
    // reason은 의도적으로 'auth'가 아님 — 'auth'는 쿨다운 없는 영구 개방이라 fleet 자가복구를 막는다.
    expect(result?.reason).toBe('generic');
    expect(result?.immediateOpen).toBe(true);
    expect(result?.resetTime).toBeNull();
    expect(result?.matchedText).toMatch(/^provider error envelope: /);
  });

  it('is a strict no-op when the toggle is disabled', () => {
    for (const off of ['off', 'false', '0']) {
      expect(classifyProviderErrorEnvelope(realAuthEnvelope, off)).toBeNull();
    }
  });

  it('does not match a team report body that merely quotes the auth error', () => {
    const reportBody = [
      '# 중복에러방지 감사',
      '',
      '실패 원인: opencode가 `{"type":"error"...}` 봉투로 401 invalid x-api-key를 반환했다.',
      '조치: 회로를 즉시 개방한다.',
    ].join('\n');
    expect(classifyProviderErrorEnvelope(reportBody, 'on')).toBeNull();
    // JSON 블록을 인용부호로 감싼 마크다운도 '{'로 시작하지 않으므로 매칭되지 않는다.
    expect(classifyProviderErrorEnvelope('```json\n' + realAuthEnvelope + '\n```', 'on')).toBeNull();
  });

  it('ignores envelopes that are not a single parseable error object', () => {
    expect(classifyProviderErrorEnvelope(null, 'on')).toBeNull();
    expect(classifyProviderErrorEnvelope('   ', 'on')).toBeNull();
    expect(classifyProviderErrorEnvelope('{ not json', 'on')).toBeNull();
    expect(classifyProviderErrorEnvelope('[{"type":"error"}]', 'on')).toBeNull();
    // type !== 'error' (정상 산출물 봉투)
    expect(
      classifyProviderErrorEnvelope(
        JSON.stringify({ type: 'result', message: 'invalid x-api-key 401' }),
        'on',
      ),
    ).toBeNull();
  });

  it('ignores oversized output (team deliverable, not a provider envelope)', () => {
    const padded = JSON.stringify({
      type: 'error',
      error: { data: { message: 'invalid x-api-key', statusCode: 401 } },
      detail: 'x'.repeat(9000),
    });
    expect(padded.length).toBeGreaterThan(8192);
    expect(classifyProviderErrorEnvelope(padded, 'on')).toBeNull();
  });

  it('does not take auth signals from non-whitelisted keys', () => {
    const summaryOnly = JSON.stringify({
      type: 'error',
      summary: 'invalid x-api-key (401)',
      body: 'HTTP 401 unauthorized',
    });
    expect(classifyProviderErrorEnvelope(summaryOnly, 'on')).toBeNull();
  });

  it('leaves quota/rate-limit envelopes out of scope in this cycle', () => {
    const quota = JSON.stringify({
      type: 'error',
      error: { name: 'APIError', data: { message: 'rate limit exceeded', statusCode: 429 } },
    });
    const classified = classifyCircuitError('rate limit exceeded');
    expect(classified?.reason).not.toBe('auth');
    expect(classifyProviderErrorEnvelope(quota, 'on')).toBeNull();
  });
});

// GATE-CONTENT-STRAT-R1 (cycle1 중복에러방지팀, team_content-strategy-2026).
// 픽스처는 2026-07-28 09:00:01 UTC GET /api/tasks/task_trend_collector 본문 스냅샷.
describe('isExternalInjectionPhantom (GATE-CONTENT-STRAT-R1)', () => {
  const previousGuard = process.env.NCO_ORPHAN_EXTERNAL_INJECTION_GUARD;

  afterEach(() => {
    if (previousGuard === undefined) delete process.env.NCO_ORPHAN_EXTERNAL_INJECTION_GUARD;
    else process.env.NCO_ORPHAN_EXTERNAL_INJECTION_GUARD = previousGuard;
  });

  // Live HTTP body (2026-07-28T09:16Z): team_id 유지, response/result/evidence null,
  // metadata_json/system_prompt/spawned_by_cli null, orphan_requeue_count=0, assigned_to=retired-local-provider.
  const trendCollectorRow = {
    teamId: 'team_content-strategy-2026',
    metadataJson: null,
    systemPrompt: null,
    spawnedByCli: null,
    orphanRequeueCount: 0,
  };

  it('flags the live task_trend_collector provenance snapshot without opening the provider circuit', () => {
    process.env.NCO_ORPHAN_EXTERNAL_INJECTION_GUARD = 'on';
    const breaker = new CircuitBreaker('ollama');
    breaker.reset();

    expect(breaker.isExternalInjectionPhantom(trendCollectorRow)).toBe(true);
    expect(breaker.getState()).toBe('closed');
    expect(breaker.getFailures()).toBe(0);
  });

  it('is a strict no-op when the orphan external-injection guard is disabled', () => {
    for (const off of ['off', 'false', '0']) {
      process.env.NCO_ORPHAN_EXTERNAL_INJECTION_GUARD = off;
      const breaker = new CircuitBreaker('ollama-off');
      expect(breaker.isExternalInjectionPhantom(trendCollectorRow)).toBe(false);
    }
  });

  it('does not flag an NCO team-runner row (metadata + spawned_by_cli present)', () => {
    process.env.NCO_ORPHAN_EXTERNAL_INJECTION_GUARD = 'on';
    const breaker = new CircuitBreaker('agy');
    // Live sibling task_EbTqTcR3_iFzfMQB (agy, spawned_by_cli=team-runner, metadata SET).
    expect(breaker.isExternalInjectionPhantom({
      teamId: 'team_content-strategy-2026',
      metadataJson: '{"requestedProvider":"agy","promptGate":{"enriched":true}}',
      systemPrompt: null,
      spawnedByCli: 'team-runner',
      orphanRequeueCount: 0,
    })).toBe(false);
  });

  it('does not treat timeout/agent-nonresponse strings as this gate (wrong failure class)', () => {
    // CB threshold changes would target these classes; this team's 50% root cause was not them.
    expect(classifyCircuitError('Job wait timed out before finishing, no finish notification arrived')).toBeNull();
    expect(classifyCircuitError('agent non-response')).toBeNull();
    expect(classifyCircuitError('invalid input')).toBeNull();
  });
});

describe('classifyCircuitError — 명령 에코(argv) 오탐', () => {
  // 실측 사건(2026-07-29 06:02:05Z): claude-code가 취소된 뒤 execa shortMessage가 프롬프트 전문을
  // 그대로 실어 왔고, 그 안의 'Roth IRA/401(k)'가 AUTH_PATTERNS의 /\b401\b/에 걸려
  // circuit_states.claude-code = open/auth/cooldown_until=NULL(영구 차단)이 됐다.
  const INCIDENT = "claude-code: subprocess cancelled: Command was canceled: claude "
    + "--dangerously-skip-permissions -p '[회사 워크플로우 필수 토론] 7개 대표 주제 중 이미 완료된 "
    + "Roth IRA/401(k) 1건은 재검증하고, 나머지는 신규 작성한다.'";

  afterEach(() => {
    delete process.env.NCO_CB_STRIP_ARGV;
  });

  it('프롬프트 본문의 401(k)를 인증 실패로 오분류하지 않는다', () => {
    expect(classifyCircuitError(INCIDENT)).toBeNull();
  });

  it('롤백 플래그(off)를 켜면 이전 동작(오탐)으로 정확히 되돌아간다', () => {
    process.env.NCO_CB_STRIP_ARGV = 'off';
    expect(classifyCircuitError(INCIDENT)?.reason).toBe('auth');
  });

  it('프로바이더 stdout 오류 봉투의 진짜 인증·쿼터 신호는 그대로 분류한다', () => {
    expect(classifyCircuitError(
      '{"type":"error","error":{"type":"authentication_error","message":"invalid api key"}}',
    )?.reason).toBe('auth');
    expect(classifyCircuitError('HTTP 401 Unauthorized')?.reason).toBe('auth');
    expect(classifyCircuitError("You've hit your weekly limit · resets 4am (Asia/Seoul)")?.reason)
      .toBe('quota');
  });

  it('명령 에코 앞의 종료코드 머리말은 보존한다', () => {
    expect(stripCommandEcho("Command failed with exit code 1: claude -p 'quota unauthorized 401'"))
      .toBe('Command failed with exit code 1:');
    expect(stripCommandEcho('rate limit exceeded')).toBe('rate limit exceeded');
  });
});

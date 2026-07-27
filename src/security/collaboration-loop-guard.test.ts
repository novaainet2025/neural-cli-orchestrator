import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// circuit-breaker.ts는 registry를 통해 DB/Redis/이벤트버스를 끌어오므로,
// 순수 인메모리 룰만 검증하기 위해 부작용 경로를 전부 스텁한다.
vi.mock('../storage/database.js', () => ({
  getDb: () => { throw new Error('database unavailable in unit test'); },
}));
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

import {
  CircuitBreaker,
  CollaborationLoopGuard,
  collaborationChannelKey,
  collaborationLoopGuard,
  DEFAULT_COLLABORATION_LOOP_CONFIG,
} from './circuit-breaker.js';

describe('collaboration-msg-loop rule', () => {
  let guard: CollaborationLoopGuard;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    guard = new CollaborationLoopGuard();
  });

  afterEach(() => {
    vi.useRealTimers();
    collaborationLoopGuard.reset();
  });

  const channel = collaborationChannelKey('team-a', 'team-b');
  const config = { windowMs: 60_000, maxRepeatsPerWindow: 3, maxMessagesPerWindow: 20, cooldownMs: 60_000 };

  it('allows normal collaboration traffic with varied content', () => {
    for (let i = 0; i < 10; i++) {
      const decision = guard.check(channel, `stage ${i} output`, config);
      expect(decision.allowed).toBe(true);
      expect(decision.rule).toBeNull();
    }
  });

  // 48h 실측: 동일 (from,to) 채널에서 완전히 같은 본문이 60초 이내 최대 72회 재전송됨.
  it('blocks an identical message echoed past the repeat cap within the window', () => {
    const body = 'done: collaboration invite';
    expect(guard.check(channel, body, config).allowed).toBe(true);
    expect(guard.check(channel, body, config).allowed).toBe(true);
    expect(guard.check(channel, body, config).allowed).toBe(true);

    const blocked = guard.check(channel, body, config);
    expect(blocked.allowed).toBe(false);
    expect(blocked.rule).toBe('echo-loop');
    expect(blocked.repeats).toBe(4);
    expect(blocked.cooldownUntil).toBe(Date.now() + config.cooldownMs);
  });

  it('treats whitespace-only differences as the same message', () => {
    const config2 = { ...config, maxRepeatsPerWindow: 1 };
    expect(guard.check(channel, 'status: working', config2).allowed).toBe(true);
    const blocked = guard.check(channel, '  status:   working \n', config2);
    expect(blocked.allowed).toBe(false);
    expect(blocked.rule).toBe('echo-loop');
  });

  // 48h 실측: 동일 채널 분당 최대 41건 (정상 협업 채널은 ≈1.3건/시간).
  it('blocks a burst of distinct messages past the per-window cap', () => {
    for (let i = 0; i < config.maxMessagesPerWindow; i++) {
      expect(guard.check(channel, `unique message ${i}`, config).allowed).toBe(true);
    }
    const blocked = guard.check(channel, 'unique message overflow', config);
    expect(blocked.allowed).toBe(false);
    expect(blocked.rule).toBe('channel-burst');
    expect(blocked.windowCount).toBe(config.maxMessagesPerWindow + 1);
  });

  it('lets repeats through once they fall outside the sliding window', () => {
    const body = 'status: still working';
    for (let i = 0; i < 3; i++) expect(guard.check(channel, body, config).allowed).toBe(true);
    expect(guard.check(channel, body, config).allowed).toBe(false);

    // 쿨다운 + 윈도를 모두 넘긴 뒤에는 같은 본문도 다시 통과해야 한다.
    vi.advanceTimersByTime(config.windowMs + config.cooldownMs + 1);
    const after = guard.check(channel, body, config);
    expect(after.allowed).toBe(true);
    expect(after.repeats).toBe(1);
  });

  // 루프는 차단당해도 계속 재시도한다. 차단된 시도가 쿨다운을 연장하면 채널이
  // 영구 봉쇄되므로, 쿨다운은 반드시 유한해야 한다.
  it('does not extend the cooldown when a looping sender keeps retrying', () => {
    const body = 'question: which path?';
    for (let i = 0; i < 3; i++) guard.check(channel, body, config);
    const tripped = guard.check(channel, body, config);
    expect(tripped.allowed).toBe(false);
    const cooldownUntil = tripped.cooldownUntil!;

    for (let i = 0; i < 50; i++) {
      vi.advanceTimersByTime(1_000);
      const retry = guard.check(channel, body, config);
      if (retry.allowed) break;
      expect(retry.cooldownUntil).toBe(cooldownUntil); // 연장되지 않음
    }

    vi.setSystemTime(new Date(cooldownUntil + 1));
    expect(guard.check(channel, body, config).allowed).toBe(true);
  });

  it('isolates channels — one looping channel does not block its peers', () => {
    const noisy = collaborationChannelKey('team-a', 'team-b');
    const quiet = collaborationChannelKey('team-a', 'team-c');
    const body = 'done: same body';

    for (let i = 0; i < 3; i++) guard.check(noisy, body, config);
    expect(guard.check(noisy, body, config).allowed).toBe(false);
    expect(guard.check(quiet, body, config).allowed).toBe(true);
  });

  it('evicts the least-recently-used channel past the tracking cap', () => {
    const capped = { ...config, maxTrackedChannels: 2 };
    guard.check('a->b', 'x', capped);
    vi.advanceTimersByTime(1_000);
    guard.check('c->d', 'x', capped);
    vi.advanceTimersByTime(1_000);
    guard.check('e->f', 'x', capped); // 'a->b'가 가장 오래됨 → 축출

    expect(guard.snapshot('a->b').tracked).toBe(false);
    expect(guard.snapshot('c->d').tracked).toBe(true);
    expect(guard.snapshot('e->f').tracked).toBe(true);
  });

  it('reset clears a channel cooldown', () => {
    const body = 'error: repeated';
    for (let i = 0; i < 3; i++) guard.check(channel, body, config);
    expect(guard.check(channel, body, config).allowed).toBe(false);

    guard.reset(channel);
    expect(guard.snapshot(channel).tracked).toBe(false);
    expect(guard.check(channel, body, config).allowed).toBe(true);
  });

  it('falls back to defaults for invalid config values', () => {
    const bad = { windowMs: -1, maxRepeatsPerWindow: 0, maxMessagesPerWindow: Number.NaN } as never;
    for (let i = 0; i < DEFAULT_COLLABORATION_LOOP_CONFIG.maxRepeatsPerWindow; i++) {
      expect(guard.check(channel, 'body', bad).allowed).toBe(true);
    }
    expect(guard.check(channel, 'body', bad).allowed).toBe(false);
  });

  it('exposes the rule through CircuitBreaker without touching provider circuit state', () => {
    collaborationLoopGuard.reset();
    const breaker = new CircuitBreaker('collab-loop-agent');
    const body = 'done: handoff';

    for (let i = 0; i < 3; i++) {
      expect(breaker.checkCollaborationMessage('peer-session', body, config).allowed).toBe(true);
    }
    const blocked = breaker.checkCollaborationMessage('peer-session', body, config);
    expect(blocked.allowed).toBe(false);
    expect(blocked.rule).toBe('echo-loop');
    expect(blocked.channel).toBe('collab-loop-agent->peer-session');

    // 협업 루프는 프로바이더 장애가 아니다 — 회로는 닫힌 채로 유지되어야 한다.
    expect(breaker.getState()).toBe('closed');
    expect(breaker.getFailures()).toBe(0);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { HiveRelay, createHiveRelay, type SessionInfo } from './hive-relay.js';

const session = (id: string, name = id): SessionInfo => ({ id, name });

describe('HiveRelay — session registry', () => {
  let relay: HiveRelay;

  beforeEach(() => {
    relay = createHiveRelay({ inviteCodes: ['GOOD', 'ALSO-GOOD'] });
  });

  it('joins with a valid invite code and lists the session', () => {
    const res = relay.joinSession('GOOD', session('s1', 'Alpha'));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.session.id).toBe('s1');
      expect(res.session.seq).toBe(0);
      expect(res.session.inviteCode).toBe('GOOD');
    }
    expect(relay.hasSession('s1')).toBe(true);

    const list = relay.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('Alpha');
  });

  it('rejects an invalid / empty invite code', () => {
    const bad = relay.joinSession('NOPE', session('s2'));
    expect(bad).toEqual({ ok: false, error: 'invalid_invite' });

    const empty = relay.joinSession('', session('s3'));
    expect(empty).toEqual({ ok: false, error: 'invalid_invite' });

    expect(relay.listSessions()).toHaveLength(0);
  });

  it('rejects a duplicate join of the same session id', () => {
    expect(relay.joinSession('GOOD', session('dup')).ok).toBe(true);
    const again = relay.joinSession('ALSO-GOOD', session('dup'));
    expect(again).toEqual({ ok: false, error: 'duplicate_session' });
    expect(relay.listSessions()).toHaveLength(1);
  });

  it('rejects a malformed session', () => {
    const res = relay.joinSession('GOOD', { id: '', name: '' });
    expect(res).toEqual({ ok: false, error: 'invalid_session' });
  });

  it('provides a unified view ordered by join sequence', () => {
    relay.joinSession('GOOD', session('a'));
    relay.joinSession('GOOD', session('b'));
    relay.joinSession('GOOD', session('c'));
    expect(relay.listSessions().map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('HiveRelay — knowledge distillation', () => {
  let relay: HiveRelay;

  beforeEach(() => {
    relay = createHiveRelay({ idGenerator: (seq) => `k-${seq}` });
  });

  it('distills a shared best_practice and exposes it via getSharedKnowledge', () => {
    const item = relay.distill({ content: 'Always inject the clock', type: 'best_practice' });
    expect(item).toMatchObject({
      id: 'k-0',
      type: 'best_practice',
      content: 'Always inject the clock',
      scope: 'shared',
    });

    const shared = relay.getSharedKnowledge();
    expect(shared).toHaveLength(1);
    expect(shared[0]!.id).toBe('k-0');
  });

  it('keeps personal (local) patterns out of shared knowledge', () => {
    relay.distill({ content: 'Team lesson', type: 'technique' });
    relay.distill({ content: 'My private shortcut', type: 'technique', personal: true });

    const shared = relay.getSharedKnowledge();
    const local = relay.getLocalKnowledge();

    expect(shared.map((k) => k.content)).toEqual(['Team lesson']);
    expect(local.map((k) => k.content)).toEqual(['My private shortcut']);
    expect(shared.every((k) => k.scope === 'shared')).toBe(true);
    expect(relay.getAllKnowledge()).toHaveLength(2);
  });

  it('defaults to best_practice and shared scope, and uses the injected id generator', () => {
    const item = relay.distill({ content: 'No type given', sourceSessionId: 's1' });
    expect(item.type).toBe('best_practice');
    expect(item.scope).toBe('shared');
    expect(item.id).toBe('k-0');
    expect(item.sourceSessionId).toBe('s1');
  });

  it('throws on a decision without content', () => {
    expect(() => relay.distill({ content: '' })).toThrow(/content is required/);
  });
});

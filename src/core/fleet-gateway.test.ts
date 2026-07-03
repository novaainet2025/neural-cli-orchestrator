import { beforeEach, describe, expect, it } from 'vitest';
import {
  createFleetGateway,
  FleetGateway,
  FleetRegistryError,
  FleetTransitionError,
} from './fleet-gateway.js';

describe('FleetGateway', () => {
  let fleet: FleetGateway;

  beforeEach(() => {
    fleet = createFleetGateway();
    fleet.registerNode('node-a', { host: '10.0.0.1', tags: ['gpu'] });
    fleet.registerNode('node-b', { host: '10.0.0.2', tags: ['cpu'] });
    fleet.registerNode('node-c', { host: '10.0.0.3' });
  });

  it('registers nodes as active and rejects duplicates', () => {
    expect(fleet.getNode('node-a').status).toBe('active');
    expect(fleet.getNode('node-a').tags).toEqual(['gpu']);
    expect(fleet.getNode('node-c').tags).toEqual([]);
    expect(() =>
      fleet.registerNode('node-a', { host: '10.0.0.9' }),
    ).toThrow(FleetRegistryError);
  });

  it('excludes cordoned and draining nodes from routing', () => {
    // baseline: all three active
    expect(fleet.selectRoutableNodes().map((n) => n.name)).toEqual([
      'node-a',
      'node-b',
      'node-c',
    ]);

    fleet.cordon('node-b');
    fleet.drain('node-c');

    const routable = fleet.selectRoutableNodes().map((n) => n.name);
    expect(routable).toEqual(['node-a']);
    expect(routable).not.toContain('node-b'); // cordoned excluded
    expect(routable).not.toContain('node-c'); // draining excluded
  });

  it('excludes offline nodes from routing and re-includes after activate', () => {
    fleet.markOffline('node-a');
    expect(fleet.selectRoutableNodes().map((n) => n.name)).not.toContain(
      'node-a',
    );

    // activate brings an offline node back into rotation
    fleet.activate('node-a');
    expect(fleet.selectRoutableNodes().map((n) => n.name)).toContain('node-a');
  });

  it('follows the legal state machine (drain -> cordon -> activate -> restart)', () => {
    expect(fleet.drain('node-a').status).toBe('draining');
    expect(fleet.cordon('node-a').status).toBe('cordoned'); // draining -> cordoned legal
    expect(fleet.activate('node-a').status).toBe('active'); // cordoned -> active legal
    fleet.markOffline('node-a');
    expect(fleet.restart('node-a').status).toBe('active'); // offline -> active via restart
  });

  it('rejects illegal transitions', () => {
    // drain is only legal from active
    fleet.cordon('node-a'); // active -> cordoned
    expect(() => fleet.drain('node-a')).toThrow(FleetTransitionError);

    // activate is illegal on an already-active node
    expect(() => fleet.activate('node-b')).toThrow(FleetTransitionError);

    // cordon is illegal from offline
    fleet.markOffline('node-c');
    expect(() => fleet.cordon('node-c')).toThrow(FleetTransitionError);
  });

  it('throws on control verbs against unknown nodes', () => {
    expect(() => fleet.drain('ghost')).toThrow(FleetRegistryError);
    expect(() => fleet.getNode('ghost')).toThrow(FleetRegistryError);
  });

  it('produces a deterministic topology snapshot with injected ts', () => {
    fleet.pair('node-a', 'node-b');
    fleet.pair('node-c', 'node-a'); // normalized to a<b => node-a/node-c
    fleet.drain('node-b');

    const snap = fleet.snapshot(1234);

    // ts is exactly what the caller injected (no wall clock)
    expect(snap.ts).toBe(1234);

    // nodes sorted by name, full shape
    expect(snap.nodes.map((n) => n.name)).toEqual([
      'node-a',
      'node-b',
      'node-c',
    ]);
    expect(snap.nodes[0]).toEqual({
      name: 'node-a',
      host: '10.0.0.1',
      tags: ['gpu'],
      status: 'active',
    });

    // pairings normalized (a<=b) and sorted
    expect(snap.pairings).toEqual([
      { a: 'node-a', b: 'node-b' },
      { a: 'node-a', b: 'node-c' },
    ]);

    // presence maps each node -> its current status
    expect(snap.presence).toEqual({
      'node-a': 'active',
      'node-b': 'draining',
      'node-c': 'active',
    });

    // determinism: same state + same ts => identical snapshot
    expect(fleet.snapshot(1234)).toEqual(snap);
  });

  it('returns defensive copies (mutating results does not corrupt registry)', () => {
    const node = fleet.getNode('node-a');
    node.tags.push('mutated');
    node.status = 'offline';
    expect(fleet.getNode('node-a').tags).toEqual(['gpu']);
    expect(fleet.getNode('node-a').status).toBe('active');
  });
});

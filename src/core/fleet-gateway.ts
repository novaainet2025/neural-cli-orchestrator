/**
 * fleet-gateway.ts — Fleet node gateway control (swarmclaw port).
 *
 * Pure in-memory registry for fleet nodes with an explicit lifecycle state
 * machine, routing selection, and a deterministic topology snapshot.
 *
 * Design notes:
 *  - No I/O, no timers, no globals — fully deterministic and unit-testable.
 *  - `Date.now()` / `Math.random()` are intentionally NOT used. Any timestamp
 *    is injected by the caller (see `snapshot(ts)`).
 *  - Illegal state transitions throw `FleetTransitionError` (never silently
 *    swallowed) so callers can react.
 */

/** Lifecycle state of a fleet node. */
export type NodeStatus = 'active' | 'draining' | 'cordoned' | 'offline';

/** Control verbs that drive the node state machine. */
export type NodeAction = 'activate' | 'drain' | 'cordon' | 'restart';

/** Options accepted when registering a node. */
export interface RegisterNodeOptions {
  host: string;
  tags?: string[];
}

/** A registered fleet node. */
export interface FleetNode {
  name: string;
  host: string;
  tags: string[];
  status: NodeStatus;
}

/** Immutable snapshot view of a node (safe to hand out). */
export interface NodeSnapshot {
  name: string;
  host: string;
  tags: string[];
  status: NodeStatus;
}

/** An undirected pairing between two nodes (a < b, normalized). */
export interface Pairing {
  a: string;
  b: string;
}

/** Full topology snapshot. `ts` is caller-injected — never wall-clock here. */
export interface TopologySnapshot {
  ts: number;
  nodes: NodeSnapshot[];
  pairings: Pairing[];
  presence: Record<string, NodeStatus>;
}

/** Thrown when a control verb is applied from an incompatible source state. */
export class FleetTransitionError extends Error {
  readonly node: string;
  readonly action: NodeAction;
  readonly from: NodeStatus;

  constructor(node: string, action: NodeAction, from: NodeStatus) {
    super(
      `Illegal transition: cannot '${action}' node '${node}' from state '${from}'`,
    );
    this.name = 'FleetTransitionError';
    this.node = node;
    this.action = action;
    this.from = from;
  }
}

/** Thrown for registry lookup / duplicate-registration errors. */
export class FleetRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetRegistryError';
  }
}

/**
 * Transition table: for each control verb, the set of source states from which
 * it is legal, plus the resulting target state.
 *
 *  - activate: bring a paused/offline node back into rotation.
 *  - drain:    stop accepting new routes but keep node up (active -> draining).
 *  - cordon:   mark unschedulable (from active or draining).
 *  - restart:  cycle a node back to active from any non-fresh state.
 */
const TRANSITIONS: Record<
  NodeAction,
  { from: readonly NodeStatus[]; to: NodeStatus }
> = {
  activate: { from: ['draining', 'cordoned', 'offline'], to: 'active' },
  drain: { from: ['active'], to: 'draining' },
  cordon: { from: ['active', 'draining'], to: 'cordoned' },
  restart: { from: ['active', 'draining', 'cordoned', 'offline'], to: 'active' },
};

function normalizePair(a: string, b: string): Pairing {
  return a <= b ? { a, b } : { a: b, b: a };
}

function pairKey(a: string, b: string): string {
  const p = normalizePair(a, b);
  return `${p.a}\0${p.b}`;
}

/**
 * In-memory fleet gateway. Construct one per fleet (or use as a singleton).
 */
export class FleetGateway {
  private readonly nodes = new Map<string, FleetNode>();
  private readonly pairings = new Map<string, Pairing>();

  /** Register a new node. Defaults to `active`. Duplicate names are rejected. */
  registerNode(name: string, opts: RegisterNodeOptions): FleetNode {
    if (!name) {
      throw new FleetRegistryError('Node name must be a non-empty string');
    }
    if (this.nodes.has(name)) {
      throw new FleetRegistryError(`Node '${name}' is already registered`);
    }
    const node: FleetNode = {
      name,
      host: opts.host,
      tags: [...(opts.tags ?? [])],
      status: 'active',
    };
    this.nodes.set(name, node);
    return { ...node, tags: [...node.tags] };
  }

  /** Whether a node exists. */
  hasNode(name: string): boolean {
    return this.nodes.has(name);
  }

  /** Look up a node (throws if absent). Returns a defensive copy. */
  getNode(name: string): FleetNode {
    const node = this.requireNode(name);
    return { ...node, tags: [...node.tags] };
  }

  /** All nodes as immutable snapshots, sorted by name. */
  listNodes(): NodeSnapshot[] {
    return [...this.nodes.values()]
      .map((n) => this.toSnapshot(n))
      .sort((x, y) => x.name.localeCompare(y.name));
  }

  // ---- control verbs -------------------------------------------------------

  activate(name: string): FleetNode {
    return this.applyAction(name, 'activate');
  }

  drain(name: string): FleetNode {
    return this.applyAction(name, 'drain');
  }

  cordon(name: string): FleetNode {
    return this.applyAction(name, 'cordon');
  }

  restart(name: string): FleetNode {
    return this.applyAction(name, 'restart');
  }

  /**
   * Mark a node offline (e.g. missed heartbeat). Legal from any state and
   * idempotent — this represents an observed fact, not a control verb, so it
   * is never rejected.
   */
  markOffline(name: string): FleetNode {
    const node = this.requireNode(name);
    node.status = 'offline';
    return { ...node, tags: [...node.tags] };
  }

  // ---- routing -------------------------------------------------------------

  /**
   * Nodes eligible to receive new routes. ONLY `active` nodes qualify —
   * `draining`, `cordoned`, and `offline` are excluded. This is the core of
   * "draining nodes are removed from routing".
   */
  selectRoutableNodes(): NodeSnapshot[] {
    return [...this.nodes.values()]
      .filter((n) => n.status === 'active')
      .map((n) => this.toSnapshot(n))
      .sort((x, y) => x.name.localeCompare(y.name));
  }

  // ---- pairings ------------------------------------------------------------

  /** Create an undirected pairing between two registered nodes. */
  pair(a: string, b: string): Pairing {
    this.requireNode(a);
    this.requireNode(b);
    if (a === b) {
      throw new FleetRegistryError(`Cannot pair node '${a}' with itself`);
    }
    const key = pairKey(a, b);
    const pairing = normalizePair(a, b);
    this.pairings.set(key, pairing);
    return { ...pairing };
  }

  /** Remove a pairing if present. Returns true if one was removed. */
  unpair(a: string, b: string): boolean {
    return this.pairings.delete(pairKey(a, b));
  }

  // ---- snapshot ------------------------------------------------------------

  /**
   * Deterministic topology snapshot. Caller injects `ts` (unix ms or any
   * monotonic value) — this module never reads the clock itself.
   */
  snapshot(ts: number): TopologySnapshot {
    const nodes = this.listNodes();
    const pairings = [...this.pairings.values()].sort((x, y) =>
      x.a === y.a ? x.b.localeCompare(y.b) : x.a.localeCompare(y.a),
    );
    const presence: Record<string, NodeStatus> = {};
    for (const n of nodes) {
      presence[n.name] = n.status;
    }
    return { ts, nodes, pairings, presence };
  }

  // ---- internals -----------------------------------------------------------

  private requireNode(name: string): FleetNode {
    const node = this.nodes.get(name);
    if (!node) {
      throw new FleetRegistryError(`Unknown node '${name}'`);
    }
    return node;
  }

  private applyAction(name: string, action: NodeAction): FleetNode {
    const node = this.requireNode(name);
    const rule = TRANSITIONS[action];
    if (!rule.from.includes(node.status)) {
      throw new FleetTransitionError(name, action, node.status);
    }
    node.status = rule.to;
    return { ...node, tags: [...node.tags] };
  }

  private toSnapshot(n: FleetNode): NodeSnapshot {
    return { name: n.name, host: n.host, tags: [...n.tags], status: n.status };
  }
}

/** Convenience factory. */
export function createFleetGateway(): FleetGateway {
  return new FleetGateway();
}

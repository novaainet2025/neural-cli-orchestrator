/**
 * Hive Relay — Session relay registry + Hive Mind knowledge distillation.
 *
 * Ports the "협업17 Relay + Hive Mind (claudectl)" swarm pattern into NCO:
 *  - A session registry gated by invite codes (join / list — the GET /api/sessions view).
 *  - Knowledge distillation that classifies a decision into a reusable item and
 *    decides whether it is `shared` (propagated across the hive) or `local`
 *    (a personal pattern kept on the originating node only).
 *
 * The module is intentionally pure and deterministic: it never reads the clock
 * or a random source directly. Any non-determinism (id generation) is injected
 * so the behaviour is fully reproducible under test.
 */

/** Distillation category of a captured decision. */
export type KnowledgeType = 'best_practice' | 'technique';

/** Propagation scope of a distilled knowledge item. */
export type KnowledgeScope = 'shared' | 'local';

/** A distilled, reusable knowledge item produced by {@link HiveRelay.distill}. */
export interface KnowledgeItem {
  /** Stable id (from the injected id generator). */
  readonly id: string;
  readonly type: KnowledgeType;
  /** Human-readable distilled content. */
  readonly content: string;
  /** `shared` items are propagated to the hive; `local` stay on this node. */
  readonly scope: KnowledgeScope;
  /** Id of the session that produced the item, when known. */
  readonly sourceSessionId?: string;
}

/** Metadata describing a session that wants to join the hive. */
export interface SessionInfo {
  /** Caller-supplied unique session id. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Optional role/label (e.g. "codex", "reviewer"). */
  readonly role?: string;
  /** Free-form capability tags, surfaced in the unified view. */
  readonly capabilities?: readonly string[];
}

/** A session that has successfully joined, plus relay-assigned bookkeeping. */
export interface RegisteredSession extends SessionInfo {
  /** Monotonic join order assigned by the relay (deterministic). */
  readonly seq: number;
  /** The invite code used to join. */
  readonly inviteCode: string;
}

/** Input to {@link HiveRelay.distill}: a decision worth remembering. */
export interface Decision {
  /** The distilled content / lesson. */
  readonly content: string;
  /** Category. Defaults to `best_practice` when omitted. */
  readonly type?: KnowledgeType;
  /**
   * When true the decision is a personal pattern and is kept `local`;
   * otherwise it is `shared` and propagated across the hive.
   */
  readonly personal?: boolean;
  /** Originating session id, if any. */
  readonly sourceSessionId?: string;
}

/** Discriminated result of a join attempt. */
export type JoinResult =
  | { readonly ok: true; readonly session: RegisteredSession }
  | { readonly ok: false; readonly error: JoinError };

/** Reasons a join can fail. */
export type JoinError = 'invalid_invite' | 'duplicate_session' | 'invalid_session';

/** Construction options for {@link HiveRelay}. */
export interface HiveRelayOptions {
  /** Whitelist of accepted invite codes. Empty ⇒ no session can join. */
  readonly inviteCodes?: Iterable<string>;
  /**
   * Deterministic id generator for distilled knowledge items. Receives a
   * monotonically increasing sequence number. Defaults to `k-<seq>`.
   */
  readonly idGenerator?: (seq: number) => string;
}

/**
 * In-memory session relay + knowledge distiller. Deterministic and
 * self-contained — safe to instantiate per hive without external I/O.
 */
export class HiveRelay {
  private readonly inviteCodes: Set<string>;
  private readonly sessions = new Map<string, RegisteredSession>();
  private readonly knowledge: KnowledgeItem[] = [];
  private readonly idGenerator: (seq: number) => string;
  private sessionSeq = 0;
  private knowledgeSeq = 0;

  constructor(options: HiveRelayOptions = {}) {
    this.inviteCodes = new Set(options.inviteCodes ?? []);
    this.idGenerator = options.idGenerator ?? ((seq) => `k-${seq}`);
  }

  /** Register a new invite code at runtime. */
  addInviteCode(code: string): void {
    if (code) this.inviteCodes.add(code);
  }

  /**
   * Attempt to join the hive with an invite code.
   * Fails on an unknown/empty invite code, a malformed session, or a session
   * id that has already joined.
   */
  joinSession(inviteCode: string, sessionInfo: SessionInfo): JoinResult {
    if (!sessionInfo || !sessionInfo.id || !sessionInfo.name) {
      return { ok: false, error: 'invalid_session' };
    }
    if (!inviteCode || !this.inviteCodes.has(inviteCode)) {
      return { ok: false, error: 'invalid_invite' };
    }
    if (this.sessions.has(sessionInfo.id)) {
      return { ok: false, error: 'duplicate_session' };
    }

    const session: RegisteredSession = {
      id: sessionInfo.id,
      name: sessionInfo.name,
      role: sessionInfo.role,
      capabilities: sessionInfo.capabilities ? [...sessionInfo.capabilities] : undefined,
      seq: this.sessionSeq++,
      inviteCode,
    };
    this.sessions.set(session.id, session);
    return { ok: true, session };
  }

  /** Remove a session from the registry. Returns whether one was removed. */
  leaveSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Whether a session id is currently registered. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Unified view of all joined sessions (equivalent to `GET /api/sessions`),
   * ordered by join sequence.
   */
  listSessions(): RegisteredSession[] {
    return [...this.sessions.values()].sort((a, b) => a.seq - b.seq);
  }

  /**
   * Distill a decision into a reusable knowledge item and file it. `shared`
   * items become part of the propagated hive knowledge; `local` (personal)
   * items are retained but never propagated.
   */
  distill(decision: Decision): KnowledgeItem {
    if (!decision || !decision.content) {
      throw new Error('distill: decision.content is required');
    }
    const item: KnowledgeItem = {
      id: this.idGenerator(this.knowledgeSeq++),
      type: decision.type ?? 'best_practice',
      content: decision.content,
      scope: decision.personal ? 'local' : 'shared',
      sourceSessionId: decision.sourceSessionId,
    };
    this.knowledge.push(item);
    return item;
  }

  /** All distilled items, in insertion order (shared + local). */
  getAllKnowledge(): KnowledgeItem[] {
    return [...this.knowledge];
  }

  /** Only the propagation-eligible (`shared`) knowledge items. */
  getSharedKnowledge(): KnowledgeItem[] {
    return this.knowledge.filter((k) => k.scope === 'shared');
  }

  /** Only the node-private (`local`) knowledge items. */
  getLocalKnowledge(): KnowledgeItem[] {
    return this.knowledge.filter((k) => k.scope === 'local');
  }
}

/** Convenience factory mirroring the NCO module style. */
export function createHiveRelay(options: HiveRelayOptions = {}): HiveRelay {
  return new HiveRelay(options);
}

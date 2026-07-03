import type Database from 'better-sqlite3';

/**
 * PA Inbox — Persistent Agent inbox model (ported from "협업15 / optio").
 *
 * A slug-addressed, durable inbox backed by SQLite (better-sqlite3, already a
 * project dependency — see src/storage/database.ts). Every persistent agent
 * owns an inbox keyed by its `slug`. Messages are enqueued by producers and
 * drained once-per-turn by the owning agent; a drain atomically returns all
 * currently-unread messages and marks them read in a single transaction so a
 * concurrent producer can never cause a message to be both returned twice or
 * lost.
 *
 * Design notes:
 *  - Storage is injected (`Database.Database`) so callers control the DB file
 *    (persistent path) or use `:memory:` in tests. This mirrors task-state.ts.
 *  - Determinism: no direct `Date.now()` / `Math.random()`. A `now()` clock is
 *    injected; message identity/ordering comes from SQLite AUTOINCREMENT rowid
 *    (FIFO), not randomness.
 *  - Durability: undrained messages persist across process restarts because
 *    they live in the SQLite file until drained. Reopening the same file
 *    exposes the same pending rows.
 */

/** Injected monotonic-ish clock returning epoch milliseconds. */
export type Clock = () => number;

/** Message states within an inbox. */
export type MessageStatus = 'pending' | 'read' | 'dead';

/** A message as returned to callers. */
export interface InboxMessage {
  /** Monotonic rowid — stable, FIFO-ordered identity. */
  readonly id: number;
  /** Inbox address this message belongs to. */
  readonly slug: string;
  /** Opaque payload (already serialized by the caller). */
  readonly body: string;
  /** Epoch ms when the message was enqueued (from injected clock). */
  readonly enqueuedAt: number;
}

/** Options for {@link PaInbox}. */
export interface PaInboxOptions {
  /** Injected clock; defaults to a wrapper the caller may still override. */
  readonly now: Clock;
  /**
   * How long (ms) a message may sit in `pending` before {@link PaInbox.reconcile}
   * considers it stale. Stale messages are either re-queued (bumped to the tail)
   * or dead-lettered once they exceed {@link PaInboxOptions.maxDeliveries}.
   */
  readonly staleAfterMs?: number;
  /**
   * Maximum number of delivery attempts before a stale message is dead-lettered
   * instead of re-queued. Defaults to 3.
   */
  readonly maxDeliveries?: number;
}

/** Result of a {@link PaInbox.reconcile} pass. */
export interface ReconcileResult {
  /** Messages re-queued for another delivery attempt. */
  readonly requeued: number;
  /** Messages marked dead (exceeded maxDeliveries). */
  readonly deadLettered: number;
}

const DEFAULT_STALE_AFTER_MS = 5 * 60_000; // 5 minutes
const DEFAULT_MAX_DELIVERIES = 3;

/**
 * Durable, slug-addressed inbox. Construct once per DB handle; the table is
 * created idempotently so an existing DB file is reused as-is.
 */
export class PaInbox {
  private readonly db: Database.Database;
  private readonly now: Clock;
  private readonly staleAfterMs: number;
  private readonly maxDeliveries: number;

  // Prepared statements (compiled once per instance).
  private readonly stmtInsert: Database.Statement;
  private readonly stmtSelectPending: Database.Statement;
  private readonly stmtMarkRead: Database.Statement;
  private readonly stmtSelectStale: Database.Statement;
  private readonly stmtRequeue: Database.Statement;
  private readonly stmtDeadLetter: Database.Statement;
  private readonly drainTxn: (slug: string) => InboxMessage[];

  constructor(db: Database.Database, options: PaInboxOptions) {
    this.db = db;
    this.now = options.now;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.maxDeliveries = options.maxDeliveries ?? DEFAULT_MAX_DELIVERIES;

    this.migrate();

    this.stmtInsert = db.prepare(
      `INSERT INTO pa_inbox (slug, body, status, deliveries, enqueued_at, updated_at)
       VALUES (@slug, @body, 'pending', 0, @ts, @ts)`,
    );
    this.stmtSelectPending = db.prepare(
      `SELECT id, slug, body, enqueued_at AS enqueuedAt
         FROM pa_inbox
        WHERE slug = ? AND status = 'pending'
        ORDER BY id ASC`,
    );
    this.stmtMarkRead = db.prepare(
      `UPDATE pa_inbox
          SET status = 'read', deliveries = deliveries + 1, updated_at = @ts
        WHERE slug = @slug AND status = 'pending'`,
    );
    this.stmtSelectStale = db.prepare(
      `SELECT id, deliveries
         FROM pa_inbox
        WHERE status = 'pending' AND updated_at <= @cutoff
        ORDER BY id ASC`,
    );
    this.stmtRequeue = db.prepare(
      `UPDATE pa_inbox
          SET deliveries = deliveries + 1, updated_at = @ts
        WHERE id = @id`,
    );
    this.stmtDeadLetter = db.prepare(
      `UPDATE pa_inbox
          SET status = 'dead', updated_at = @ts
        WHERE id = @id`,
    );

    // Atomic drain: read all pending rows, then flip them to 'read' in one txn.
    this.drainTxn = db.transaction((slug: string): InboxMessage[] => {
      const rows = this.stmtSelectPending.all(slug) as Array<{
        id: number;
        slug: string;
        body: string;
        enqueuedAt: number;
      }>;
      if (rows.length === 0) return [];
      this.stmtMarkRead.run({ slug, ts: this.now() });
      return rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        body: r.body,
        enqueuedAt: r.enqueuedAt,
      }));
    });
  }

  /** Create the backing table + indexes idempotently. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pa_inbox (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        slug        TEXT    NOT NULL,
        body        TEXT    NOT NULL,
        status      TEXT    NOT NULL DEFAULT 'pending',
        deliveries  INTEGER NOT NULL DEFAULT 0,
        enqueued_at INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pa_inbox_slug_status
        ON pa_inbox (slug, status, id);
      CREATE INDEX IF NOT EXISTS idx_pa_inbox_status_updated
        ON pa_inbox (status, updated_at);
    `);
  }

  /**
   * Enqueue a message for `slug`. Returns the assigned message id (rowid).
   * The body must already be a string (callers serialize their own payloads).
   */
  enqueue(slug: string, body: string): number {
    if (!slug) throw new Error('PaInbox.enqueue: slug is required');
    const ts = this.now();
    const info = this.stmtInsert.run({ slug, body, ts });
    return Number(info.lastInsertRowid);
  }

  /**
   * Atomically drain all currently-unread messages for `slug`: returns them in
   * FIFO order and marks them read in the same transaction. A subsequent drain
   * (with no new enqueues) returns an empty array.
   */
  drain(slug: string): InboxMessage[] {
    if (!slug) throw new Error('PaInbox.drain: slug is required');
    return this.drainTxn(slug);
  }

  /** Number of pending (undrained) messages for `slug`. */
  pendingCount(slug: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM pa_inbox WHERE slug = ? AND status = 'pending'`)
      .get(slug) as { n: number };
    return row.n;
  }

  /**
   * Self-heal pass. Any message still `pending` and untouched for longer than
   * `staleAfterMs` (measured against the injected clock) is treated as a
   * lost/stuck delivery: it is re-queued (delivery counter bumped) unless it
   * has already been attempted `maxDeliveries` times, in which case it is
   * dead-lettered (status = 'dead') so it stops blocking the inbox.
   *
   * Re-queuing simply refreshes `updated_at` so the message becomes eligible
   * for the next drain again; it never changes `id`, preserving FIFO order.
   */
  reconcile(): ReconcileResult {
    const nowMs = this.now();
    const cutoff = nowMs - this.staleAfterMs;
    const stale = this.stmtSelectStale.all({ cutoff }) as Array<{ id: number; deliveries: number }>;

    let requeued = 0;
    let deadLettered = 0;

    const runPass = this.db.transaction(() => {
      for (const row of stale) {
        if (row.deliveries >= this.maxDeliveries) {
          this.stmtDeadLetter.run({ id: row.id, ts: nowMs });
          deadLettered += 1;
        } else {
          this.stmtRequeue.run({ id: row.id, ts: nowMs });
          requeued += 1;
        }
      }
    });
    runPass();

    return { requeued, deadLettered };
  }

  /** Messages that were dead-lettered by {@link reconcile}. Inspection helper. */
  deadLetters(slug: string): InboxMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, slug, body, enqueued_at AS enqueuedAt
           FROM pa_inbox
          WHERE slug = ? AND status = 'dead'
          ORDER BY id ASC`,
      )
      .all(slug) as Array<{ id: number; slug: string; body: string; enqueuedAt: number }>;
    return rows.map((r) => ({ id: r.id, slug: r.slug, body: r.body, enqueuedAt: r.enqueuedAt }));
  }
}

/**
 * Convenience factory mirroring the project's functional-module style.
 * Prefer this when you just need an inbox bound to an already-open DB handle.
 */
export function createPaInbox(db: Database.Database, options: PaInboxOptions): PaInbox {
  return new PaInbox(db, options);
}

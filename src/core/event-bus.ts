import { EventEmitter } from 'eventemitter3';
import { getRedis, getSubscriber, isRedisConnected } from '../storage/redis.js';
import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';
import { createEventId } from '../utils/id.js';
import { NCOEvent, EventHandler } from './types.js';
export type { NCOEvent, EventHandler };

const log = createLogger('event-bus');

const CHANNEL = 'nco:events';
const STREAM = 'nco:event-stream';
const MAX_STREAM_LEN = 10000;
/** Cap localEmittedIds (echo suppression) — trim oldest batch when exceeded. */
const LOCAL_EMITTED_IDS_MAX = 5000;
const LOCAL_EMITTED_IDS_PRUNE_BATCH = 1000;

// ─── Persistent Event Types (saved to SQLite) ─────────
const PERSIST_TYPES = new Set([
  'action:write', 'action:create', 'action:edit', 'action:delete',
  'action:run', 'action:test', 'action:git',
  'message:direct', 'message:broadcast', 'message:review',
  'message:approve', 'message:reject',
  'task:created', 'task:completed', 'task:failed',
  'discussion:started', 'discussion:completed',
  'discussion:round_completed', 'discussion:consensus_reached',
  'system:error', 'system:rate_limit',
]);

export class EventBus {
  private local = new EventEmitter();
  private ready = false;
  private sequence = 0;
  // Track locally-emitted event IDs to prevent Redis echo causing double-emit
  private localEmittedIds = new Set<string>();

  async init(): Promise<void> {
    if (this.ready) return;

    try {
      const sub = await getSubscriber();
      await sub.subscribe(CHANNEL);

      sub.on('message', (_channel: string, message: string) => {
        try {
          const event = JSON.parse(message) as NCOEvent;
          // Skip re-emit if this event was already emitted locally in publish()
          if (this.localEmittedIds.has(event.id)) return;
          this.local.emit(event.type, event);
          this.local.emit('*', event);
        } catch (err) {
          log.error({ err }, 'Failed to parse event');
        }
      });

      try {
        const db = getDb();
        db.prepare(`CREATE TABLE IF NOT EXISTS event_queue (id TEXT PRIMARY KEY, channel TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()))`).run();
      } catch { }

      // Consumer Group for multi-instance support
      try {
        const redisForGroup = await getRedis();
        await redisForGroup.xgroup('CREATE', STREAM, 'nco-consumers', '0', 'MKSTREAM');
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes('BUSYGROUP')) log.warn({ err: msg }, 'Consumer group setup skipped');
      }

      this.ready = true;
      log.info('Event Bus initialized (Redis Pub/Sub + Streams)');

      setInterval(async () => {
        if (!isRedisConnected()) return;
        try {
          const db = getDb();
          const pending = db.prepare(`SELECT * FROM event_queue ORDER BY created_at LIMIT 50`).all() as any[];
          if (pending.length === 0) return;
          const redis = await getRedis();
          await redis.ping();
          for (const row of pending) {
            await redis.publish(row.channel, row.payload);
            db.prepare(`DELETE FROM event_queue WHERE id=?`).run(row.id);
          }
        } catch { }
      }, 5000);
    } catch (err) {
      log.warn({ err }, 'Redis unavailable, Event Bus in local-only mode');
      this.ready = true; // local-only fallback
    }
  }

  // ─── Publish ────────────────────────────────────────
  async publish(event: Omit<NCOEvent, 'id' | 'timestamp'> & { type: string }): Promise<NCOEvent> {
    const enriched: NCOEvent = {
      ...event,
      id: createEventId(),
      timestamp: Date.now(),
    };

    this.sequence++;

    // 1. Local emit (always works) — track ID to suppress Redis echo
    if (this.localEmittedIds.size > LOCAL_EMITTED_IDS_MAX) {
      Array.from(this.localEmittedIds)
        .slice(0, LOCAL_EMITTED_IDS_PRUNE_BATCH)
        .forEach((id) => this.localEmittedIds.delete(id));
    }
    this.localEmittedIds.add(enriched.id);
    setTimeout(() => this.localEmittedIds.delete(enriched.id), 30000);
    this.local.emit(enriched.type, enriched);
    this.local.emit('*', enriched);

    // 2. Redis Pub/Sub + Streams
    if (isRedisConnected()) {
      try {
        const redis = await getRedis();
        const payload = JSON.stringify(enriched);

        // Pub/Sub for real-time
        await redis.publish(CHANNEL, payload);

        // Streams for sequence + replay
        await redis.xadd(STREAM, 'MAXLEN', '~', String(MAX_STREAM_LEN),
          '*',
          'type', enriched.type,
          'data', payload
        );
      } catch (err) {
        log.error({ err, type: enriched.type }, 'Redis publish failed');
        try {
          const db = getDb();
          db.prepare(`INSERT OR IGNORE INTO event_queue (id, channel, payload) VALUES (?, ?, ?)`).run(enriched.id, CHANNEL, JSON.stringify(enriched));
        } catch { }
      }
    }

    // 3. SQLite persist (important events)
    if (PERSIST_TYPES.has(enriched.type)) {
      this.persistEvent(enriched);
    }

    return enriched;
  }

  // ─── Subscribe ──────────────────────────────────────
  on(eventType: string, handler: EventHandler): void {
    this.local.on(eventType, handler);
  }

  off(eventType: string, handler: EventHandler): void {
    this.local.off(eventType, handler);
  }

  once(eventType: string, handler: EventHandler): void {
    this.local.once(eventType, handler);
  }

  // Subscribe to all events for a specific agent
  onAgent(agentId: string, handler: EventHandler): void {
    this.local.on('*', (event: NCOEvent) => {
      if (
        ('agentId' in event && event.agentId === agentId) ||
        ('to' in event && event.to === agentId) ||
        ('from' in event && event.from === agentId) ||
        ('assigned_to' in event && event.assigned_to === agentId)
      ) {
        handler(event);
      }
    });
  }

  // ─── Consumer Group (XREADGROUP) ────────────────────
  /**
   * Process pending messages from the Redis consumer group.
   * GROUP = 'nco-consumers', CONSUMER_ID = `nco-${process.pid}`
   * Uses XREADGROUP to claim pending messages and XACK after processing.
   * Runs alongside replaySince() — duplicate prevention via localEmittedIds.
   */
  async startConsumerGroup(): Promise<void> {
    if (!isRedisConnected()) return;

    const GROUP = 'nco-consumers';
    const CONSUMER_ID = `nco-${process.pid}`;

    const processPending = async () => {
      if (!isRedisConnected()) return;
      try {
        const redis = await getRedis();
        // Read up to 100 pending messages assigned to this consumer
        const results = await redis.xreadgroup(
          'GROUP', GROUP, CONSUMER_ID,
          'COUNT', '100',
          'STREAMS', STREAM, '>',
        ) as Array<[string, Array<[string, string[]]>]> | null;

        if (!results) return;

        for (const [, entries] of results) {
          for (const [msgId, fields] of entries) {
            try {
              const dataIdx = fields.indexOf('data');
              if (dataIdx >= 0) {
                const event = JSON.parse(fields[dataIdx + 1]) as NCOEvent;
                // Emit only if not already emitted locally
                if (!this.localEmittedIds.has(event.id)) {
                  this.local.emit(event.type, event);
                  this.local.emit('*', event);
                }
              }
              // Acknowledge the message regardless
              await redis.xack(STREAM, GROUP, msgId);
            } catch (err) {
              log.error({ err, msgId }, 'Consumer group message processing failed');
            }
          }
        }
      } catch (err) {
        log.warn({ err }, 'XREADGROUP consume cycle failed');
      }
    };

    // Run once immediately, then every 5 seconds
    await processPending();
    setInterval(processPending, 5_000);

    log.info({ group: GROUP, consumer: CONSUMER_ID }, 'Consumer group started');
  }

  // ─── Replay (for reconnection) ─────────────────────
  async replaySince(lastEventId: string): Promise<NCOEvent[]> {
    if (!isRedisConnected()) return [];

    try {
      const redis = await getRedis();
      const entries = await redis.xrange(STREAM, lastEventId, '+', 'COUNT', '500');

      return entries.map(([_id, fields]: [string, string[]]) => {
        const dataIdx = fields.indexOf('data');
        if (dataIdx >= 0) {
          return JSON.parse(fields[dataIdx + 1]) as NCOEvent;
        }
        return null;
      }).filter(Boolean) as NCOEvent[];
    } catch (err) {
      log.error({ err }, 'Replay failed');
      return [];
    }
  }

  // ─── Persist to SQLite ──────────────────────────────
  private persistEvent(event: NCOEvent): void {
    try {
      const db = getDb();
      const agentId = (event as any).agentId || (event as any).from || null;
      const taskId = (event as any).taskId || null;
      const sessionId = (event as any).sessionId || (event as any).discussionId || null;

      db.prepare(`
        INSERT INTO agent_actions (id, agent_id, action_type, target, detail_json, task_id, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        agentId || 'system',
        event.type,
        (event as any).path || (event as any).to || null,
        JSON.stringify(event),
        taskId,
        sessionId
      );
    } catch (err) {
      log.error({ err, type: event.type }, 'Event persist failed');
    }
  }

  // ─── Echo-suppression Set maintenance ───────────────
  private trimLocalEmittedIdsIfNeeded(): void {
    if (this.localEmittedIds.size > LOCAL_EMITTED_IDS_MAX) {
      Array.from(this.localEmittedIds).slice(0, LOCAL_EMITTED_IDS_PRUNE_BATCH).forEach(id => this.localEmittedIds.delete(id));
    }
  }

  // ─── Cleanup ────────────────────────────────────────
  destroy(): void {
    this.local.removeAllListeners();
    this.ready = false;
  }
}

export const eventBus = new EventBus();

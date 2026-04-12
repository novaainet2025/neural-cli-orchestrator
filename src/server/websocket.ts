import http from 'http';
import { pack, unpack } from 'msgpackr';
import { WebSocketServer, WebSocket } from 'ws';
import type { BridgeServerMessage } from '../bridge/types.js';
import { eventBus, type NCOEvent } from '../core/event-bus.js';
import { env } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { nanoid } from 'nanoid';

const log = createLogger('websocket');

// ─── RFC 6902 JSON Patch (flat-key diff, no external dep) ─
type JsonPatchOp = { op: 'add' | 'replace' | 'remove'; path: string; value?: unknown };

function computeJsonPatch(prev: Record<string, unknown>, next: Record<string, unknown>): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    const path = `/${key}`;
    if (!(key in prev)) {
      ops.push({ op: 'add', path, value: next[key] });
    } else if (!(key in next)) {
      ops.push({ op: 'remove', path });
    } else if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
      ops.push({ op: 'replace', path, value: next[key] });
    }
  }
  return ops;
}

// Event types where delta encoding is applied (state-update events)
const DELTA_EVENT_TYPES = new Set([
  'agent:status', 'agent:heartbeat', 'task:started', 'task:completed', 'task:failed',
  'discussion:round_completed', 'discussion:completed',
]);

interface ClientInfo {
  id: string;
  ws: WebSocket;
  subscriptions: Set<string>;
  lastSeq: string;
  connectedAt: number;
  /** When true, event payloads are sent as msgpackr binary; protocol messages via send() stay JSON. */
  isBinary: boolean;
  /** When true, send JSON Patch diffs for state-update events instead of full payloads. */
  deltaMode: boolean;
  /** Last-sent state snapshot per event-type key (agentId or taskId) for delta diffing. */
  lastState: Map<string, Record<string, unknown>>;
}

class RingBuffer<T> {
  private buf: T[];
  private head = 0;
  private size = 0;
  constructor(private cap: number) {
    this.buf = new Array(cap);
  }
  push(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.cap;
    if (this.size < this.cap) this.size++;
  }
  toArray(): T[] {
    const r: T[] = [];
    for (let i = 0; i < this.size; i++) {
      r.push(this.buf[(this.head - this.size + i + this.cap) % this.cap]);
    }
    return r;
  }
}

class WebSocketBridge {
  private wss: WebSocketServer | null = null;
  private server: http.Server | null = null;
  private clients = new Map<string, ClientInfo>();
  private eventBuffer = new RingBuffer<NCOEvent>(1000);
  private maxBufferSize = 1000;
  private lastBroadcast = 0;
  private pendingBroadcast: NCOEvent[] = [];

  async start(): Promise<void> {
    this.server = http.createServer();
    this.wss = new WebSocketServer({ server: this.server, perMessageDeflate: { zlibDeflateOptions: { level: 6 }, threshold: 1024 } });

    this.wss.on('connection', (ws, req) => {
      const clientId = nanoid(12);
      const client: ClientInfo = {
        id: clientId,
        ws,
        subscriptions: new Set(),
        lastSeq: '0',
        connectedAt: Date.now(),
        isBinary: false,
        deltaMode: false,
        lastState: new Map(),
      };
      this.clients.set(clientId, client);

      // Handle discussion path: /discussion/:id
      const match = req.url?.match(/^\/discussion\/(.+)$/);
      if (match) {
        client.subscriptions.add(`discussion:${match[1]}`);
      }

      this.send(ws, {
        type: 'connected',
        clientId,
        timestamp: new Date().toISOString(),
        path: req.url,
      });

      log.debug({ clientId, path: req.url }, 'Client connected');

      ws.on('message', (raw) => {
        try {
          const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBufferLike);
          let msg: unknown;
          try {
            msg = JSON.parse(buf.toString('utf8'));
          } catch {
            msg = unpack(buf);
          }
          if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
            this.handleClientMessage(client, msg as Record<string, unknown>);
          }
        } catch {
          this.send(ws, { type: 'error', message: 'Invalid message' });
        }
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
        log.debug({ clientId }, 'Client disconnected');
      });

      ws.on('error', (err) => {
        log.error({ clientId, err: err.message }, 'WebSocket error');
      });
    });

    // Bridge: Event Bus → all WebSocket clients
    eventBus.on('*', (event: NCOEvent) => {
      this.bufferEvent(event);
      this.broadcastToClients(event);
    });

    this.server.listen(env.WS_PORT, '127.0.0.1', () => {
      log.info({ port: env.WS_PORT }, 'WebSocket server listening');
    });
  }

  // ─── Client Message Handling ────────────────────────
  private handleClientMessage(client: ClientInfo, msg: Record<string, unknown>): void {
    if (typeof msg.type !== 'string') {
      this.send(client.ws, { type: 'echo', received: msg, timestamp: new Date().toISOString() });
      return;
    }
    switch (msg.type) {
      case 'init':
        if (msg.binary === true) {
          client.isBinary = true;
        }
        if (msg.delta === true) {
          client.deltaMode = true;
        }
        break;

      case 'subscribe': {
        const taskId = typeof msg.taskId === 'string' ? msg.taskId : undefined;
        const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;
        const agentId = typeof msg.agentId === 'string' ? msg.agentId : undefined;
        if (taskId) client.subscriptions.add(taskId);
        if (sessionId) client.subscriptions.add(`discussion:${sessionId}`);
        if (agentId) client.subscriptions.add(`agent:${agentId}`);
        this.send(client.ws, {
          type: 'subscribed',
          taskId,
          sessionId,
          agentId,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      case 'unsubscribe':
        if (typeof msg.taskId === 'string') client.subscriptions.delete(msg.taskId);
        if (typeof msg.sessionId === 'string') {
          client.subscriptions.delete(`discussion:${msg.sessionId}`);
        }
        if (typeof msg.agentId === 'string') {
          client.subscriptions.delete(`agent:${msg.agentId}`);
        }
        this.send(client.ws, { type: 'unsubscribed', timestamp: new Date().toISOString() });
        break;

      case 'ping':
        this.send(client.ws, { type: 'pong', timestamp: Date.now() });
        break;

      case 'replay': {
        // Replay events since lastSeq
        const last = msg.lastEventId;
        const lastStr =
          typeof last === 'string' ? last : last != null ? String(last) : '0';
        void this.replayEvents(client, lastStr);
        break;
      }

      // User intervention in discussion
      case 'discussion:intervene':
        if (typeof msg.sessionId === 'string' && typeof msg.content === 'string') {
          eventBus.publish({
            type: 'discussion:user_intervention',
            sessionId: msg.sessionId,
            from: 'user',
            content: msg.content,
          });
        }
        break;

      default:
        this.send(client.ws, { type: 'echo', received: msg, timestamp: new Date().toISOString() });
    }
  }

  // ─── Broadcast to matching clients ──────────────────
  private broadcastToClients(event: NCOEvent): void {
    const now = Date.now();
    const elapsed = now - this.lastBroadcast;

    if (elapsed < 16) {
      this.pendingBroadcast.push(event);
      const remaining = 16 - elapsed;
      if (this.pendingBroadcast.length === 1) {
        setTimeout(() => this.flushPendingBroadcast(), remaining);
      }
      return;
    }

    this.flushEvent(event);
    this.lastBroadcast = now;
  }

  private flushPendingBroadcast(): void {
    if (this.pendingBroadcast.length === 0) return;
    for (const event of this.pendingBroadcast) {
      this.flushEvent(event);
    }
    this.pendingBroadcast = [];
    this.lastBroadcast = Date.now();
  }

  private flushEvent(event: NCOEvent): void {
    for (const client of this.clients.values()) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      // Filter: if client has subscriptions, only send matching events
      if (client.subscriptions.size > 0) {
        const taskId = (event as { taskId?: string }).taskId;
        const sessionId =
          (event as { sessionId?: string; discussionId?: string }).sessionId ||
          (event as { discussionId?: string }).discussionId;
        const evtAgentId =
          (event as { agentId?: string; from?: string }).agentId ||
          (event as { from?: string }).from;
        const discussionKey = sessionId ? `discussion:${sessionId}` : null;
        const agentKey = evtAgentId ? `agent:${evtAgentId}` : null;

        const matches = (taskId && client.subscriptions.has(taskId)) ||
                        (discussionKey && client.subscriptions.has(discussionKey)) ||
                        (agentKey && client.subscriptions.has(agentKey));

        // Also always send system events, agent status, and mesh events
        const isGlobal = event.type.startsWith('system:') ||
                         event.type.startsWith('agent:') ||
                         event.type.startsWith('mesh:') ||
                         event.type === 'message:broadcast';

        if (!matches && !isGlobal) continue;
      }

      // Backpressure: check buffered amount
      if (client.ws.bufferedAmount > 1024 * 1024) {
        log.warn({ clientId: client.id }, 'Backpressure: skipping event');
        continue;
      }

      // JSON Patch delta encoding for state-update events
      let sendData: unknown = event;
      if (client.deltaMode && DELTA_EVENT_TYPES.has(event.type)) {
        const stateKey = (event as any).agentId || (event as any).taskId || event.type;
        const prev = client.lastState.get(stateKey) ?? {};
        const next = event as unknown as Record<string, unknown>;
        const patch = computeJsonPatch(prev, next);
        client.lastState.set(stateKey, next);
        if (patch.length > 0) {
          sendData = { type: 'patch', target: stateKey, patch, id: event.id };
        } else {
          continue; // no change — skip send
        }
      }

      const payload = client.isBinary ? pack(sendData) : JSON.stringify(sendData);
      client.ws.send(payload);
      client.lastSeq = event.id;
    }
  }

  // ─── Replay missed events ──────────────────────────
  private async replayEvents(client: ClientInfo, lastEventId: string): Promise<void> {
    const missed = await eventBus.replaySince(lastEventId);

    this.send(client.ws, {
      type: 'replay_start',
      count: missed.length,
      from: lastEventId,
    });

    for (const event of missed) {
      if (client.ws.readyState === WebSocket.OPEN) {
        const payload = client.isBinary ? pack(event) : JSON.stringify(event);
        client.ws.send(payload);
      }
    }

    this.send(client.ws, { type: 'replay_end', count: missed.length });
    log.info({ clientId: client.id, replayed: missed.length }, 'Replay complete');
  }

  // ─── Buffer for short-term replay ──────────────────
  private bufferEvent(event: NCOEvent): void {
    this.eventBuffer.push(event);
  }

  // ─── Helpers ────────────────────────────────────────
  private send(ws: WebSocket, data: BridgeServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  stop(): void {
    for (const client of this.clients.values()) {
      client.ws.close();
    }
    this.clients.clear();
    this.wss?.close();
    this.server?.close();
    log.info('WebSocket server stopped');
  }
}

export const wsBridge = new WebSocketBridge();

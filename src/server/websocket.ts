import http from 'http';
import { pack, unpack } from 'msgpackr';
import { WebSocketServer, WebSocket } from 'ws';
import type { BridgeServerMessage } from '../bridge/types.js';
import { eventBus, type EventHandler, type NCOEvent } from '../core/event-bus.js';
import { env } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { nanoid } from 'nanoid';

const log = createLogger('websocket');
const SERVICE_RESTART_CLOSE_CODE = 1012;
const SERVICE_RESTART_REASON_PREFIX = 'Service Restart';
const SERVICE_RESTART_CLOSE_DRAIN_MS = 250;

/** Max keys per client lastState map; LRU eviction when exceeded. */
const LAST_STATE_MAX_KEYS = 10_000;

function lastStateTouchGet(
  map: Map<string, Record<string, unknown>>,
  key: string,
): Record<string, unknown> | undefined {
  const v = map.get(key);
  if (v !== undefined) {
    map.delete(key);
    map.set(key, v);
  }
  return v;
}

function lastStateTouchSet(
  map: Map<string, Record<string, unknown>>,
  key: string,
  value: Record<string, unknown>,
): void {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > LAST_STATE_MAX_KEYS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function stateKeyForDelta(event: NCOEvent): string {
  const e = event as { agentId?: string; taskId?: string; sessionId?: string; discussionId?: string };
  if (e.agentId) return `agent:${e.agentId}`;
  if (e.taskId) return `task:${e.taskId}`;
  const sid = e.sessionId ?? e.discussionId;
  if (sid) return `discussion:${sid}`;
  return `type:${event.type}`;
}

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
    } else {
      const pv = prev[key], nv = next[key];
      // Fast path: identical references or primitive equality
      if (pv === nv) continue;
      // Fallback: deep comparison via JSON for objects/arrays
      if (typeof pv === 'object' || typeof nv === 'object') {
        if (JSON.stringify(pv) === JSON.stringify(nv)) continue;
      }
      ops.push({ op: 'replace', path, value: nv });
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
  isBinary: boolean;
  deltaMode: boolean;
  lastState: Map<string, Record<string, unknown>>;
  pendingTimers: Set<ReturnType<typeof setTimeout>>;
}

function pruneLastStateMaps(clients: Map<string, ClientInfo>, event: NCOEvent): void {
  const isTaskEnd = event.type === 'task:completed' || event.type === 'task:failed' || event.type === 'task:cancelled';
  const isAgentEnd = event.type === 'agent:terminated' || event.type === 'agent:offline' || event.type === 'agent:failed';
  const isDiscussionEnd = event.type === 'discussion:completed';

  if (isTaskEnd) {
    const taskId = (event as { taskId?: string }).taskId;
    const agentId = (event as { agentId?: string }).agentId;
    for (const c of clients.values()) {
      if (taskId) c.lastState.delete(`task:${taskId}`);
      if (agentId) c.lastState.delete(`agent:${agentId}`);
      c.lastState.delete(`type:${event.type}`);
    }
  } else if (isAgentEnd) {
    const agentId = (event as { agentId?: string }).agentId;
    if (agentId) {
      for (const c of clients.values()) {
        c.lastState.delete(`agent:${agentId}`);
        c.lastState.delete(`type:${event.type}`);
      }
    }
  } else if (isDiscussionEnd) {
    const sid = (event as { sessionId?: string }).sessionId || (event as { discussionId?: string }).discussionId;
    if (sid) {
      for (const c of clients.values()) {
        c.lastState.delete(`discussion:${sid}`);
        c.lastState.delete(`type:${event.type}`);
      }
    }
  }
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
  private lastBroadcast = 0;
  private pendingBroadcast: NCOEvent[] = [];
  private pendingBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly bridgeEventHandler: EventHandler = (event: NCOEvent) => {
    this.bufferEvent(event);
    this.broadcastToClients(event);
  };

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
        pendingTimers: new Set(),
      };
      this.clients.set(clientId, client);

      const match = req.url?.match(/^\/discussion\/(.+)$/);
      if (match) {
        client.subscriptions.add(`discussion:${match[1]}`);
      }

      this.sendJsonToClient(client, {
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
          this.sendJsonToWebSocket(ws, { type: 'error', message: 'Invalid message' });
        }
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
        client.lastState.clear();
        log.debug({ clientId }, 'Client disconnected');
      });

      ws.on('error', (err) => {
        log.error({ clientId, err: err.message }, 'WebSocket error');
        this.clients.delete(clientId);
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      });
    });

    eventBus.on('*', this.bridgeEventHandler);

    this.server.listen(env.WS_PORT, '127.0.0.1', () => {
      log.info({ port: env.WS_PORT }, 'WebSocket server listening');
    });
  }

  private handleClientMessage(client: ClientInfo, msg: Record<string, unknown>): void {
    if (typeof msg.type !== 'string') {
      this.sendJsonToClient(client, { type: 'echo', received: msg, timestamp: new Date().toISOString() });
      return;
    }
    switch (msg.type) {
      case 'init':
        if (msg.binary === true) client.isBinary = true;
        if (msg.delta === true) client.deltaMode = true;
        break;

      case 'subscribe': {
        const taskId = typeof msg.taskId === 'string' ? msg.taskId : undefined;
        const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;
        const agentId = typeof msg.agentId === 'string' ? msg.agentId : undefined;
        if (taskId) client.subscriptions.add(taskId);
        if (sessionId) client.subscriptions.add(`discussion:${sessionId}`);
        if (agentId) client.subscriptions.add(`agent:${agentId}`);
        this.sendJsonToClient(client, {
          type: 'subscribed',
          taskId,
          sessionId,
          agentId,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      case 'unsubscribe':
        if (typeof msg.taskId === 'string') {
          client.subscriptions.delete(msg.taskId);
          client.lastState.delete(msg.taskId);
        }
        if (typeof msg.sessionId === 'string') {
          client.subscriptions.delete(`discussion:${msg.sessionId}`);
        }
        if (typeof msg.agentId === 'string') {
          client.subscriptions.delete(`agent:${msg.agentId}`);
          client.lastState.delete(msg.agentId);
        }
        this.sendJsonToClient(client, { type: 'unsubscribed', timestamp: new Date().toISOString() });
        break;

      case 'ping':
        this.sendJsonToClient(client, { type: 'pong', timestamp: Date.now() });
        break;

      case 'replay': {
        const last = msg.lastEventId;
        const lastStr =
          typeof last === 'string' ? last : last != null ? String(last) : '0';
        void this.replayEvents(client, lastStr);
        break;
      }

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
        this.sendJsonToClient(client, { type: 'echo', received: msg, timestamp: new Date().toISOString() });
    }
  }

  private broadcastToClients(event: NCOEvent): void {
    const now = Date.now();
    const elapsed = now - this.lastBroadcast;

    if (elapsed < 16) {
      this.pendingBroadcast.push(event);
      const remaining = 16 - elapsed;
      if (this.pendingBroadcast.length === 1) {
        if (this.pendingBroadcastTimer !== null) {
          clearTimeout(this.pendingBroadcastTimer);
        }
        this.pendingBroadcastTimer = setTimeout(() => {
          this.pendingBroadcastTimer = null;
          this.flushPendingBroadcast();
        }, remaining);
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
    // Pre-serialize for non-delta clients (cache per event, not per client)
    let cachedJson: string | null = null;
    let cachedBinary: Buffer | null = null;

    const ids = [...this.clients.keys()];

    // Pre-extract event fields once for subscription filtering
    const taskId = (event as { taskId?: string }).taskId;
    const sessionId =
      (event as { sessionId?: string; discussionId?: string }).sessionId ||
      (event as { discussionId?: string }).discussionId;
    const evtAgentId =
      (event as { agentId?: string; from?: string }).agentId ||
      (event as { from?: string }).from;
    const discussionKey = sessionId ? `discussion:${sessionId}` : null;
    const agentKey = evtAgentId ? `agent:${evtAgentId}` : null;
    const isGlobal = event.type.startsWith('system:') ||
                     event.type.startsWith('agent:') ||
                     event.type.startsWith('mesh:') ||
                     event.type === 'message:broadcast';

    for (const clientId of ids) {
      const client = this.clients.get(clientId);
      if (!client) continue;

      if (client.ws.readyState !== WebSocket.OPEN) continue;

      if (client.subscriptions.size > 0) {
        const matches = (taskId && client.subscriptions.has(taskId)) ||
                        (discussionKey && client.subscriptions.has(discussionKey)) ||
                        (agentKey && client.subscriptions.has(agentKey));

        if (!matches && !isGlobal) continue;
      }

      if (client.ws.bufferedAmount > 1024 * 1024) {
        log.warn({ clientId: client.id }, 'Backpressure: skipping event');
        continue;
      }

      let sendData: unknown = event;
      if (client.deltaMode && DELTA_EVENT_TYPES.has(event.type)) {
        const stateKey = stateKeyForDelta(event);
        const prev = lastStateTouchGet(client.lastState, stateKey) ?? {};
        const next = event as unknown as Record<string, unknown>;
        const patch = computeJsonPatch(prev, next);
        lastStateTouchSet(client.lastState, stateKey, next);
        if (patch.length > 0) {
          sendData = { type: 'patch', target: stateKey, patch, id: event.id };
        } else {
          continue;
        }
      }

      let payload: string | Buffer;
      if (sendData === event) {
        // Non-delta: use cached serialization
        if (client.isBinary) {
          if (cachedBinary === null) cachedBinary = pack(sendData);
          payload = cachedBinary;
        } else {
          if (cachedJson === null) cachedJson = JSON.stringify(sendData);
          payload = cachedJson;
        }
      } else {
        // Delta patch: unique per client, cannot cache
        payload = client.isBinary ? pack(sendData) : JSON.stringify(sendData);
      }
      if (!this.safeSendPayload(client, payload)) continue;
      client.lastSeq = event.id;
    }

    pruneLastStateMaps(this.clients, event);
  }

  private async replayEvents(client: ClientInfo, lastEventId: string): Promise<void> {
    const missed = await eventBus.replaySince(lastEventId);

    this.sendJsonToClient(client, {
      type: 'replay_start',
      count: missed.length,
      from: lastEventId,
    });

    for (const event of missed) {
      if (!this.clients.has(client.id)) return;
      if (client.ws.readyState !== WebSocket.OPEN) break;
      const payload = client.isBinary ? pack(event) : JSON.stringify(event);
      if (!this.safeSendPayload(client, payload)) return;
    }

    if (!this.clients.has(client.id)) return;
    this.sendJsonToClient(client, { type: 'replay_end', count: missed.length });
    log.info({ clientId: client.id, replayed: missed.length }, 'Replay complete');
    if (client.deltaMode) {
      client.lastState.clear();
    }
  }

  private bufferEvent(event: NCOEvent): void {
    this.eventBuffer.push(event);
  }

  private safeSendPayload(client: ClientInfo, payload: string | Buffer): boolean {
    if (this.clients.get(client.id) !== client) return false;
    if (client.ws.readyState !== WebSocket.OPEN) return false;
    try {
      client.ws.send(payload);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ clientId: client.id, err: message }, 'WebSocket send failed; removing client');
      this.clients.delete(client.id);
      try {
        client.ws.close();
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  private sendJsonToClient(client: ClientInfo, data: BridgeServerMessage): void {
    if (this.clients.get(client.id) !== client) return;
    if (client.ws.readyState !== WebSocket.OPEN) return;
    try {
      client.ws.send(JSON.stringify(data));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ clientId: client.id, err: message }, 'WebSocket send failed; removing client');
      this.clients.delete(client.id);
      try {
        client.ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private sendJsonToWebSocket(ws: WebSocket, data: BridgeServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message }, 'WebSocket send failed');
      for (const [id, c] of this.clients) {
        if (c.ws === ws) {
          this.clients.delete(id);
          break;
        }
      }
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  private async closeClientsForServiceRestart(reason: string): Promise<void> {
    const closingClients = [...this.clients.values()];
    if (closingClients.length === 0) return;

    await Promise.allSettled(closingClients.map((client) => new Promise<void>((resolve) => {
      if (client.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }

      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(() => {
        try {
          if (client.ws.readyState !== WebSocket.CLOSED) {
            client.ws.terminate();
          }
        } catch {
          /* ignore */
        }
        settle();
      }, SERVICE_RESTART_CLOSE_DRAIN_MS);

      client.ws.once('close', settle);

      try {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.close(SERVICE_RESTART_CLOSE_CODE, reason);
        } else if (client.ws.readyState === WebSocket.CLOSING) {
          // Wait for in-flight close handshake until the timeout above.
        } else {
          settle();
        }
      } catch {
        try {
          client.ws.terminate();
        } catch {
          /* ignore */
        }
        settle();
      }
    })));
  }

  async stop(reasonDetail = 'planned shutdown'): Promise<void> {
    if (this.pendingBroadcastTimer !== null) {
      clearTimeout(this.pendingBroadcastTimer);
      this.pendingBroadcastTimer = null;
    }
    this.pendingBroadcast = [];

    eventBus.off('*', this.bridgeEventHandler);

    const closeReason = `${SERVICE_RESTART_REASON_PREFIX}: ${reasonDetail}`.slice(0, 123);
    await this.closeClientsForServiceRestart(closeReason);

    for (const client of this.clients.values()) {
      for (const t of client.pendingTimers) {
        clearTimeout(t);
      }
      client.pendingTimers.clear();
      client.lastState.clear();
    }
    this.clients.clear();
    await Promise.allSettled([
      new Promise<void>((resolve) => this.wss?.close(() => resolve()) ?? resolve()),
      new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve()),
    ]);
    log.info('WebSocket server stopped');
  }
}

export const wsBridge = new WebSocketBridge();

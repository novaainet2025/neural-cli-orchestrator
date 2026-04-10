import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { eventBus, type NCOEvent } from '../core/event-bus.js';
import { env } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { nanoid } from 'nanoid';

const log = createLogger('websocket');

interface ClientInfo {
  id: string;
  ws: WebSocket;
  subscriptions: Set<string>;
  lastSeq: string;
  connectedAt: number;
}

class WebSocketBridge {
  private wss: WebSocketServer | null = null;
  private server: http.Server | null = null;
  private clients = new Map<string, ClientInfo>();
  private eventBuffer: NCOEvent[] = [];
  private maxBufferSize = 1000;

  async start(): Promise<void> {
    this.server = http.createServer();
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws, req) => {
      const clientId = nanoid(12);
      const client: ClientInfo = {
        id: clientId,
        ws,
        subscriptions: new Set(),
        lastSeq: '0',
        connectedAt: Date.now(),
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
          const msg = JSON.parse(raw.toString());
          this.handleClientMessage(client, msg);
        } catch {
          this.send(ws, { type: 'error', message: 'Invalid JSON' });
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
  private handleClientMessage(client: ClientInfo, msg: any): void {
    switch (msg.type) {
      case 'subscribe':
        if (msg.taskId) client.subscriptions.add(msg.taskId);
        if (msg.sessionId) client.subscriptions.add(`discussion:${msg.sessionId}`);
        this.send(client.ws, {
          type: 'subscribed',
          taskId: msg.taskId, sessionId: msg.sessionId,
          timestamp: new Date().toISOString(),
        });
        break;

      case 'unsubscribe':
        if (msg.taskId) client.subscriptions.delete(msg.taskId);
        if (msg.sessionId) client.subscriptions.delete(`discussion:${msg.sessionId}`);
        this.send(client.ws, { type: 'unsubscribed', timestamp: new Date().toISOString() });
        break;

      case 'ping':
        this.send(client.ws, { type: 'pong', timestamp: Date.now() });
        break;

      case 'replay':
        // Replay events since lastSeq
        this.replayEvents(client, msg.lastEventId || '0');
        break;

      // User intervention in discussion
      case 'discussion:intervene':
        if (msg.sessionId && msg.content) {
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
    const payload = JSON.stringify(event);

    for (const client of this.clients.values()) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      // Filter: if client has subscriptions, only send matching events
      if (client.subscriptions.size > 0) {
        const taskId = (event as any).taskId;
        const sessionId = (event as any).sessionId || (event as any).discussionId;
        const discussionKey = sessionId ? `discussion:${sessionId}` : null;

        const matches = (taskId && client.subscriptions.has(taskId)) ||
                        (discussionKey && client.subscriptions.has(discussionKey));

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
        client.ws.send(JSON.stringify(event));
      }
    }

    this.send(client.ws, { type: 'replay_end', count: missed.length });
    log.info({ clientId: client.id, replayed: missed.length }, 'Replay complete');
  }

  // ─── Buffer for short-term replay ──────────────────
  private bufferEvent(event: NCOEvent): void {
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.maxBufferSize) {
      this.eventBuffer = this.eventBuffer.slice(-this.maxBufferSize);
    }
  }

  // ─── Helpers ────────────────────────────────────────
  private send(ws: WebSocket, data: any): void {
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

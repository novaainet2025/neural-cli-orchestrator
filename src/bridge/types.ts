import { z } from 'zod/v4';
import type { NCOEvent } from '../core/types.js';

/**
 * WebSocket 브릿지(:6201) 클라이언트 → 서버 메시지.
 * `websocket.ts`의 `handleClientMessage` switch와 동일한 계약.
 */
export const BridgeClientInitSchema = z.object({
  type: z.literal('init'),
  binary: z.boolean().optional(),
});

export const BridgeClientSubscribeSchema = z.object({
  type: z.literal('subscribe'),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
});

export const BridgeClientUnsubscribeSchema = z.object({
  type: z.literal('unsubscribe'),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
});

export const BridgeClientPingSchema = z.object({
  type: z.literal('ping'),
});

export const BridgeClientReplaySchema = z.object({
  type: z.literal('replay'),
  lastEventId: z.union([z.string(), z.number()]).optional().nullable(),
});

export const BridgeClientDiscussionInterveneSchema = z.object({
  type: z.literal('discussion:intervene'),
  sessionId: z.string(),
  content: z.string(),
});

export const BridgeClientMessageSchema = z.discriminatedUnion('type', [
  BridgeClientInitSchema,
  BridgeClientSubscribeSchema,
  BridgeClientUnsubscribeSchema,
  BridgeClientPingSchema,
  BridgeClientReplaySchema,
  BridgeClientDiscussionInterveneSchema,
]);

export type BridgeClientMessage = z.infer<typeof BridgeClientMessageSchema>;

/** 알려진 타입이 아니면 echo 분기로 처리 (임의 JSON 허용). */
export type BridgeClientInbound =
  | BridgeClientMessage
  | { type: string; [key: string]: unknown };

// ─── Server → client (JSON, `send()` 경로) ─────────────────

export const BridgeServerConnectedSchema = z.object({
  type: z.literal('connected'),
  clientId: z.string(),
  timestamp: z.string(),
  path: z.string().optional(),
});

export const BridgeServerSubscribedSchema = z.object({
  type: z.literal('subscribed'),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  timestamp: z.string(),
});

export const BridgeServerUnsubscribedSchema = z.object({
  type: z.literal('unsubscribed'),
  timestamp: z.string(),
});

export const BridgeServerPongSchema = z.object({
  type: z.literal('pong'),
  timestamp: z.number(),
});

export const BridgeServerReplayStartSchema = z.object({
  type: z.literal('replay_start'),
  count: z.number(),
  from: z.string(),
});

export const BridgeServerReplayEndSchema = z.object({
  type: z.literal('replay_end'),
  count: z.number(),
});

export const BridgeServerErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});

export const BridgeServerEchoSchema = z.object({
  type: z.literal('echo'),
  received: z.unknown(),
  timestamp: z.string(),
});

export const BridgeServerMessageSchema = z.discriminatedUnion('type', [
  BridgeServerConnectedSchema,
  BridgeServerSubscribedSchema,
  BridgeServerUnsubscribedSchema,
  BridgeServerPongSchema,
  BridgeServerReplayStartSchema,
  BridgeServerReplayEndSchema,
  BridgeServerErrorSchema,
  BridgeServerEchoSchema,
]);

export type BridgeServerMessage = z.infer<typeof BridgeServerMessageSchema>;

/** 브로드캐스트 페이로드: 이벤트 버스 `NCOEvent` (JSON 또는 msgpack). */
export type BridgeEventPayload = NCOEvent;

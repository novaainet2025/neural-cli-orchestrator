import { FastifyInstance, RouteOptions } from 'fastify';
import { WebSocketServer } from 'ws';
import { EventBus } from './event-bus.js';
import { SharedState } from './shared-state.js';
import { ProviderRegistry } from './provider-registry.js';

export interface NCOEvent {
  id: string;
  type: string;
  timestamp: number;
  [key: string]: unknown;
}

export type EventHandler = (event: NCOEvent) => void | Promise<void>;

export interface EventSubscription {
  event: string;
  handler: EventHandler;
}

export interface NCOModule {
  name: string;
  version: string;
  
  onRegister(core: NCOCore): Promise<void>;
  onReady(): Promise<void>;
  onShutdown(): Promise<void>;

  routes?(): RouteOptions[];
  subscriptions?(): EventSubscription[];
  optionalDependencies?(): string[];
}

export interface NCOCore {
  eventBus: EventBus;
  stateStore: SharedState;
  gateway: FastifyInstance;
  ws: WebSocketServer;
  providerRegistry: ProviderRegistry;

  getModule<T extends NCOModule>(name: string): T | null;
  hasModule(name: string): boolean;
}

export interface RouteDefinition extends RouteOptions {}
# WS Split Design

## Scope

- Immediate code change: WebSocket bridge shutdown now closes active clients with RFC 6455 close code `1012` and a `Service Restart: <reason>` close reason before process cleanup.
- Deferred work: process split, reconnect state recovery, and durable snapshot transport are design-only in this document.

## Problem

- Today the WS bridge runs in the main backend process. A backend restart drops all WS clients at once and clients cannot distinguish intentional restart from transport failure.
- Delta mode keeps `lastState` only in each `ClientInfo`. When a client reconnects, that per-connection cache is gone, so server-side patch generation restarts from an empty baseline.
- The current replay path can resend missed events by `lastEventId`, but it does not restore a reconnecting client's delta baseline or publish a canonical snapshot.

## Reconnect `lastState` Review

- Restoration is necessary for delta clients. Without it, a reconnect after restart forces patch generation from `{}` and clients cannot safely assume patch continuity unless they discard local state and rebuild from full events.
- Restoration is not required for non-delta clients because they already receive whole events and can continue with `replay`.
- This task does not implement restoration because the agreed implementation scope is limited to the `1012` shutdown path.

## Recommended Recovery Design

1. Add a process-wide snapshot store keyed by subscription target (`agent:<id>`, `task:<id>`, `discussion:<id>`, `type:<event.type>`), not by connection.
2. On every delta-eligible event, update the shared snapshot before fan-out.
3. On reconnect, let the client send `init` plus `replay` with `lastEventId`.
4. If the client requests delta mode, send `state_snapshot` frames for subscribed targets first, then replay events after the snapshot watermark.
5. After snapshot delivery, rebuild the new connection's `lastState` map from the shared snapshot so subsequent patches are generated against the restored baseline.

## WS Process Split

### Goals

- Keep REST/API restarts from tearing down long-lived WS state.
- Isolate WS backpressure, compression, and connection-count load from API request handling.
- Preserve the existing event-bus contract for publishers.

### Proposed Topology

- `api` process:
  - owns Fastify routes and task orchestration
  - publishes domain events to Redis Streams / PubSub
  - does not accept public WS connections
- `ws-bridge` process:
  - owns port `6201`
  - consumes Redis events
  - maintains shared subscription state and snapshot cache
  - serves replay/snapshot recovery for reconnecting clients

### Contracts

- Event ingress: Redis Stream remains the source of truth for replay ordering.
- Snapshot store: in-memory for single WS process, Redis-backed if multiple WS replicas are introduced.
- Health:
  - `api` health does not imply WS health
  - `ws-bridge` exposes its own readiness and client-count metrics

### Restart Behavior

- Planned `ws-bridge` restart:
  - send close code `1012`
  - clients reconnect with exponential backoff
  - clients request replay from last acknowledged event id
  - bridge restores snapshot baseline before resuming delta patches
- Planned `api` restart:
  - WS connections remain up if Redis event ingestion continues
  - clients observe only a temporary pause in new events

## Implementation Order

1. Land `1012` shutdown semantics.
2. Introduce shared snapshot cache behind the current single-process bridge.
3. Add reconnect snapshot protocol (`state_snapshot`, watermark/id).
4. Extract the bridge into a dedicated process using the same Redis event source.

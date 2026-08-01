-- Durable local fallback for EventBus publications while Redis is unavailable.
-- EventBus keeps a runtime CREATE TABLE guard for rolling upgrades, but the
-- queue belongs in the canonical schema so early publishers and test gateways
-- cannot silently lose events before EventBus.init().
CREATE TABLE IF NOT EXISTS event_queue (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_event_queue_created_at
  ON event_queue(created_at, id);

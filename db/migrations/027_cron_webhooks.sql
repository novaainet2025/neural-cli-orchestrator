-- Migration 027: Cron Jobs + Webhook Routes
-- Hermes/OpenClaw feature transplant: scheduling and webhook management

CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,
  description TEXT,
  schedule TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'nco_task',  -- 'nco_task' | 'webhook' | 'shell'
  payload TEXT NOT NULL DEFAULT '{}',           -- JSON: {ai, prompt} | {url, method, body} | {command}
  timezone TEXT NOT NULL DEFAULT 'UTC',
  max_retries INTEGER NOT NULL DEFAULT 3,
  backoff_ms INTEGER NOT NULL DEFAULT 5000,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_status TEXT,                             -- 'success' | 'failed' | null
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_routes (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,                           -- e.g. 'github/push'
  method TEXT NOT NULL DEFAULT 'POST',
  description TEXT,
  action_type TEXT NOT NULL DEFAULT 'nco_task', -- 'nco_task' | 'forward' | 'log'
  action_payload TEXT NOT NULL DEFAULT '{}',    -- JSON
  secret TEXT,                                  -- HMAC secret for verification
  enabled INTEGER NOT NULL DEFAULT 1,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(path, method)
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled);
CREATE INDEX IF NOT EXISTS idx_webhook_routes_path ON webhook_routes(path, method);

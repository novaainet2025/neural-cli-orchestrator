-- Monitoring reads project stale native runs without mutating the table.
-- This partial index keeps the active/recent dashboard path bounded.
CREATE INDEX IF NOT EXISTS idx_subagent_runs_active_updated
  ON subagent_runs(source, status, updated_at DESC)
  WHERE status IN ('starting', 'working');

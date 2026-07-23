-- NCO Claude / Codex / AGY operating snapshot
-- Window: 2026-07-16 19:07:24 KST through 2026-07-23 19:07:25 KST
-- SQLite timestamps are stored and queried in UTC.

WITH
provider_list(provider) AS (
  VALUES ('claude-code'), ('codex'), ('agy')
),
run_stats AS (
  SELECT
    agent_id AS provider,
    SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful,
    SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed,
    COUNT(*) AS total,
    ROUND(
      1.0 * SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) / COUNT(*),
      3
    ) AS success_rate,
    ROUND(
      AVG(CASE WHEN success = 1 THEN duration_ms END) / 1000.0,
      1
    ) AS avg_success_sec,
    ROUND(
      AVG(CASE WHEN success = 1 THEN output_length END)
    ) AS avg_output_chars
  FROM main.agent_evolution_log
  WHERE agent_id IN ('claude-code', 'codex', 'agy')
    AND created_at >= '2026-07-16 10:07:24'
    AND created_at <  '2026-07-23 10:07:25'
  GROUP BY agent_id
),
team_stats AS (
  SELECT lead AS provider, COUNT(*) AS active_lead_teams
  FROM main.teams
  WHERE is_active = 1
    AND lead IN ('claude-code', 'codex', 'agy')
  GROUP BY lead
),
circuit AS (
  SELECT agent_id AS provider, state AS circuit_state
  FROM main.circuit_states
  WHERE agent_id IN ('claude-code', 'codex', 'agy')
)
SELECT
  p.provider,
  COALESCE(r.successful, 0) AS successful,
  COALESCE(r.failed, 0) AS failed,
  COALESCE(r.total, 0) AS total,
  COALESCE(r.success_rate, 0) AS success_rate,
  COALESCE(r.avg_success_sec, 0) AS avg_success_sec,
  COALESCE(r.avg_output_chars, 0) AS avg_output_chars,
  COALESCE(t.active_lead_teams, 0) AS active_lead_teams,
  COALESCE(c.circuit_state, 'unknown') AS circuit_state
FROM provider_list p
LEFT JOIN run_stats r USING (provider)
LEFT JOIN team_stats t USING (provider)
LEFT JOIN circuit c USING (provider)
ORDER BY CASE p.provider
  WHEN 'claude-code' THEN 1
  WHEN 'codex' THEN 2
  WHEN 'agy' THEN 3
END;

-- Invocation-tracker reliability cross-check. This is a different grain from
-- agent_evolution_log and must not be joined or averaged with the query above.
SELECT
  target_agent_id AS provider,
  COUNT(*) AS total_rows,
  SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
  ROUND(
    1.0 * SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)
      / NULLIF(SUM(CASE WHEN status IN ('completed', 'failed', 'cancelled') THEN 1 ELSE 0 END), 0),
    3
  ) AS terminal_completion_rate,
  ROUND(
    AVG(CASE WHEN status = 'completed' THEN duration_ms END) / 1000.0,
    1
  ) AS avg_completed_sec
FROM main.agent_invocations
WHERE target_agent_id IN ('claude-code', 'codex', 'agy')
  AND created_at >= '2026-07-16 10:07:24'
  AND created_at <  '2026-07-23 10:07:25'
GROUP BY target_agent_id
ORDER BY target_agent_id;

-- Dominant terminal errors for the same seven-day window.
SELECT
  assigned_to AS provider,
  SUBSTR(COALESCE(error, '(none)'), 1, 180) AS error_pattern,
  COUNT(*) AS occurrences
FROM main.tasks
WHERE assigned_to IN ('claude-code', 'codex', 'agy')
  AND status IN ('failed', 'timed_out', 'lease_expired')
  AND created_at >= '2026-07-16 10:07:24'
  AND created_at <  '2026-07-23 10:07:25'
GROUP BY assigned_to, SUBSTR(COALESCE(error, '(none)'), 1, 180)
ORDER BY occurrences DESC, provider
LIMIT 30;

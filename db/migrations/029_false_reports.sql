-- NCO False Reports Tracking
CREATE TABLE IF NOT EXISTS false_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  agent_id TEXT,
  reason TEXT NOT NULL,
  evidence JSON,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_false_reports_task_id ON false_reports(task_id);

-- Add metric key for false reports if not exists (using 'system' as agent_id for global metrics)
INSERT INTO metrics (agent_id, metric_type, value) 
SELECT 'system', 'false_report_count', 0
WHERE NOT EXISTS (SELECT 1 FROM metrics WHERE agent_id = 'system' AND metric_type = 'false_report_count');

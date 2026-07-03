ALTER TABLE tasks ADD COLUMN last_activity_at TEXT;

UPDATE tasks
SET last_activity_at = COALESCE(updated_at, created_at, datetime('now'))
WHERE last_activity_at IS NULL;

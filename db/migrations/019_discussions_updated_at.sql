-- Add missing updated_at column to discussions table
-- SQLite does not support non-constant defaults in ALTER TABLE, so use NULL
ALTER TABLE discussions ADD COLUMN updated_at TEXT;

-- Backfill existing rows
UPDATE discussions SET updated_at = COALESCE(ended_at, created_at) WHERE updated_at IS NULL;

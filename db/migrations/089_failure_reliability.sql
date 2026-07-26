-- 089: bounded retry window + lifetime cap metadata.
-- count는 최근 6시간 window, total_count는 source task lineage의 평생 실제 재시도 수다.
ALTER TABLE retry_counts ADD COLUMN updated_at TEXT;
ALTER TABLE retry_counts ADD COLUMN total_count INTEGER NOT NULL DEFAULT 0;

UPDATE retry_counts
SET updated_at = COALESCE(updated_at, datetime('now')),
    total_count = CASE WHEN total_count < count THEN count ELSE total_count END;

CREATE INDEX IF NOT EXISTS idx_retry_counts_updated_at
  ON retry_counts(updated_at);

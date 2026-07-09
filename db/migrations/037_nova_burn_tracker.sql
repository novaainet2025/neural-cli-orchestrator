-- Nova Government — 소각 추적 테이블
-- TREASURY-POLICY.md 8회차 합의: BURN_ADDRESS 전용 소각 추적
-- 날짜: 2026-06-16

CREATE TABLE IF NOT EXISTS nova_burn_log (
  burn_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('marketplace_fee', 'large_transfer_tax', 'domain_fee', 'blacklist')),
  amount REAL NOT NULL CHECK(amount > 0),
  burned_at INTEGER NOT NULL,
  reference_id TEXT
);

CREATE VIEW IF NOT EXISTS nova_total_burned AS
  SELECT COALESCE(SUM(amount), 0) as total FROM nova_burn_log;

CREATE INDEX IF NOT EXISTS idx_burn_log_source ON nova_burn_log(source);
CREATE INDEX IF NOT EXISTS idx_burn_log_burned_at ON nova_burn_log(burned_at);

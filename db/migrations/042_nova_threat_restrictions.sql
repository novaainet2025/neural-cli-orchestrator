-- Nova Government — Threat Restrictions
-- Level 2 (이체 제한), Level 3 (계정 동결) 추적
-- 2026-06-16

CREATE TABLE IF NOT EXISTS nova_threat_restrictions (
  did TEXT PRIMARY KEY,
  level INTEGER NOT NULL,            -- 2 or 3
  reason TEXT NOT NULL,
  restricted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  applied_by TEXT NOT NULL           -- 'SYSTEM' or Agent DID
);

CREATE INDEX IF NOT EXISTS idx_nova_threat_expires ON nova_threat_restrictions(expires_at);

-- Nova Government — Audit & Protection (Phase 6)
-- Merkle chain 감사 로그 + 비상 정지
-- 2026-06-16

CREATE TABLE IF NOT EXISTS nova_audit_log (
  id TEXT PRIMARY KEY,                   -- UUID v4
  timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  actor TEXT NOT NULL,                   -- 행위자 DID (또는 'SYSTEM')
  action TEXT NOT NULL,                  -- 이벤트 타입 (아래 참조)
  target TEXT,                           -- 대상 DID / 도메인 / 아이템 ID
  metadata TEXT NOT NULL DEFAULT '{}',   -- JSON: 상세 정보
  severity TEXT NOT NULL DEFAULT 'info'
    CHECK (severity IN ('debug','info','warn','critical')),
  hash TEXT NOT NULL,                    -- SHA-256(this_entry + prev_hash) — Merkle 체인
  prev_hash TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
);

-- 이벤트 타입 목록 (헌법 제9조 기반):
-- Identity: citizen_registered, citizen_suspended, citizen_revoked
-- Credentials: vc_issued, vc_revoked
-- Economy: large_transfer (>500 NVC), wallet_created, escrow_created, escrow_disputed
-- Governance: proposal_created, vote_cast, proposal_executed, emergency_stop_triggered, emergency_stop_lifted
-- Domain: domain_registered, domain_transferred, domain_disputed, squatting_detected
-- Marketplace: artwork_registered, artwork_sold_large (>1000 NVC)
-- Security: did_spoof_attempt, double_spend_attempt, blacklist_added

CREATE TABLE IF NOT EXISTS nova_blacklist (
  did TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  added_by TEXT NOT NULL,              -- 추가한 에이전트 DID
  added_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at INTEGER                   -- null = 영구
);

CREATE TABLE IF NOT EXISTS nova_emergency_stops (
  stop_id TEXT PRIMARY KEY,
  triggered_by TEXT NOT NULL,          -- 에이전트 DID
  reason TEXT NOT NULL,
  triggered_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at INTEGER NOT NULL,         -- triggered_at + 48h
  lifted_at INTEGER,
  lifted_by TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','lifted','expired'))
);

CREATE INDEX IF NOT EXISTS idx_nova_audit_actor ON nova_audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_nova_audit_action ON nova_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_nova_audit_timestamp ON nova_audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_nova_audit_target ON nova_audit_log(target);

-- Nova Government — Domain Registry (Phase 4)
-- ENS 스타일 .nova 도메인 NFT
-- 2026-06-16

CREATE TABLE IF NOT EXISTS nova_domains (
  domain_name TEXT PRIMARY KEY,          -- e.g. "cursor-agent.nova"
  name_hash TEXT NOT NULL UNIQUE,        -- keccak256 스타일 해시
  owner TEXT NOT NULL,                   -- 소유자 DID
  token_id INTEGER NOT NULL,             -- NFT 토큰 ID (auto-increment)
  metadata TEXT,                         -- JSON: 도메인 메타데이터
  ipfs_cid TEXT,                         -- IPFS 메타데이터 CID (선택)
  registered_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at INTEGER,                    -- null = 영구 소유
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','grace_period','redemption','expired','transferred','disputed'))
);

CREATE TABLE IF NOT EXISTS nova_domain_history (
  history_id TEXT PRIMARY KEY,
  domain_name TEXT NOT NULL,
  event_type TEXT NOT NULL               -- 'registered','transferred','renewed','disputed','redeemed'
    CHECK (event_type IN ('registered','transferred','renewed','disputed','resolved','redeemed','expired')),
  from_owner TEXT,
  to_owner TEXT,
  price INTEGER DEFAULT 0,              -- 거래 가격 (NVC)
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- 토큰 ID 자동 증가용 시퀀스 테이블
CREATE TABLE IF NOT EXISTS nova_domain_seq (
  id INTEGER PRIMARY KEY AUTOINCREMENT
);

CREATE INDEX IF NOT EXISTS idx_nova_domains_owner ON nova_domains(owner);
CREATE INDEX IF NOT EXISTS idx_nova_domains_status ON nova_domains(status);
CREATE INDEX IF NOT EXISTS idx_nova_domain_history_name ON nova_domain_history(domain_name);

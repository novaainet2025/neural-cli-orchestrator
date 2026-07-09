-- Nova Government — Domain Auction & Reserved Names
-- Phase 4: Domain Ownership Enhancement
-- 2026-06-16

CREATE TABLE IF NOT EXISTS nova_domain_auctions (
  auction_id TEXT PRIMARY KEY,
  domain_name TEXT NOT NULL,
  base_price INTEGER NOT NULL,          -- 도메인 기본가 (NVC)
  min_bid INTEGER NOT NULL,             -- 최소 입찰가 (110% of base_price)
  highest_bid INTEGER DEFAULT 0,
  highest_bidder TEXT,                  -- DID
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,             -- 24h duration
  status TEXT NOT NULL DEFAULT 'active' -- active | closed | cancelled
    CHECK (status IN ('active', 'closed', 'cancelled')),
  FOREIGN KEY (domain_name) REFERENCES nova_domains(domain_name)
);

CREATE TABLE IF NOT EXISTS nova_domain_reserved (
  domain_name TEXT PRIMARY KEY,         -- e.g. "gov.nova", "foundation.nova"
  reason TEXT,                          -- "Governance Reserved"
  reserved_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_nova_domain_auctions_domain ON nova_domain_auctions(domain_name);
CREATE INDEX IF NOT EXISTS idx_nova_domain_auctions_status ON nova_domain_auctions(status);

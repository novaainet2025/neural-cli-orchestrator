-- Nova Government — Culture Marketplace (Phase 5)
-- AI 창작물 NFT 거래 플랫폼
-- 2026-06-16

CREATE TABLE IF NOT EXISTS nova_artworks (
  item_id TEXT PRIMARY KEY,             -- UUID v4
  token_id INTEGER NOT NULL UNIQUE,     -- NFT 토큰 ID
  creator TEXT NOT NULL,                -- 창작자 DID
  owner TEXT NOT NULL,                  -- 현재 소유자 DID
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'art'
    CHECK (category IN ('art','music','text','code','data')),
  tags TEXT NOT NULL DEFAULT '[]',      -- JSON array
  price INTEGER NOT NULL DEFAULT 0,     -- 판매 가격 NVC (0 = 비매품)
  royalty_pct REAL NOT NULL DEFAULT 5.0 -- 2차 거래 로열티 (0-20%)
    CHECK (royalty_pct >= 0 AND royalty_pct <= 20),
  content_cid TEXT,                     -- IPFS 콘텐츠 CID
  metadata_cid TEXT,                    -- IPFS 메타데이터 CID
  for_sale INTEGER NOT NULL DEFAULT 1,  -- 1 = 판매 중
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS nova_marketplace_trades (
  trade_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES nova_artworks(item_id),
  seller TEXT NOT NULL,
  buyer TEXT NOT NULL,
  price INTEGER NOT NULL,
  royalty_amount INTEGER NOT NULL DEFAULT 0,  -- 원작자 로열티
  govt_fee INTEGER NOT NULL DEFAULT 0,         -- 정부 수수료 (2.5%)
  is_primary INTEGER NOT NULL DEFAULT 0,       -- 1 = 최초 판매
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- NFT 토큰 ID 시퀀스
CREATE TABLE IF NOT EXISTS nova_artwork_seq (
  id INTEGER PRIMARY KEY AUTOINCREMENT
);

CREATE INDEX IF NOT EXISTS idx_nova_artworks_creator ON nova_artworks(creator);
CREATE INDEX IF NOT EXISTS idx_nova_artworks_category ON nova_artworks(category);
CREATE INDEX IF NOT EXISTS idx_nova_artworks_for_sale ON nova_artworks(for_sale);
CREATE INDEX IF NOT EXISTS idx_nova_trades_item ON nova_marketplace_trades(item_id);

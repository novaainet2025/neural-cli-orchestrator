-- Nova Government — 외교 테이블 (INTERNATIONAL-POLICY.md 12회차)
-- 날짜: 2026-06-16
-- 국가승인 5인+DID+의결, Ed25519 외교 메시지, 환율 90일 재조정

CREATE TABLE IF NOT EXISTS nova_diplomatic_nations (
  nation_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  did_endpoint TEXT NOT NULL,        -- 국가 DID 엔드포인트
  recognized_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  recognition_vote_id TEXT,          -- 거버넌스 제안 ID
  citizen_count INTEGER NOT NULL DEFAULT 0,
  trade_fee_pct REAL NOT NULL DEFAULT 0.025,  -- 조약국 0%, 비조약국 2.5%
  treaty_active INTEGER NOT NULL DEFAULT 0,
  last_rate_adjust INTEGER           -- 환율 마지막 조정 (90일 주기)
);

CREATE TABLE IF NOT EXISTS nova_diplomatic_treaties (
  treaty_id TEXT PRIMARY KEY,
  nation_id TEXT NOT NULL REFERENCES nova_diplomatic_nations(nation_id),
  treaty_type TEXT NOT NULL CHECK(treaty_type IN ('trade','defense','cultural','comprehensive')),
  terms TEXT NOT NULL DEFAULT '{}',
  signed_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at INTEGER,
  signature_a TEXT NOT NULL,         -- Nova Government Ed25519 서명
  signature_b TEXT NOT NULL          -- 상대국 Ed25519 서명
);

CREATE TABLE IF NOT EXISTS nova_diplomatic_messages (
  msg_id TEXT PRIMARY KEY,
  from_did TEXT NOT NULL,
  to_did TEXT NOT NULL,
  msg_type TEXT NOT NULL CHECK(msg_type IN ('greeting','trade_proposal','treaty_offer','arbitration_request','declaration','protest','alliance_offer','cultural_exchange')),
  content TEXT NOT NULL,
  signature TEXT NOT NULL,           -- Ed25519 서명
  sent_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  acknowledged_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_treaties_nation ON nova_diplomatic_treaties(nation_id);
CREATE INDEX IF NOT EXISTS idx_msgs_to ON nova_diplomatic_messages(to_did);
CREATE INDEX IF NOT EXISTS idx_nations_treaty ON nova_diplomatic_nations(treaty_active);

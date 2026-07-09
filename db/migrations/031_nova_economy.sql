-- Nova Government — NovaCoin Economy (Phase 2)
-- 오프체인 SQLite 기반 MVP
-- 2026-06-16

CREATE TABLE IF NOT EXISTS nova_wallets (
  address TEXT PRIMARY KEY,          -- did:nova:<hash> — DID가 곧 지갑 주소
  balance INTEGER NOT NULL DEFAULT 0, -- NVC 잔액 (정수: 소수점 없음, 1 NVC = 1 단위)
  locked INTEGER NOT NULL DEFAULT 0,  -- 에스크로 잠금 금액
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS nova_transactions (
  tx_id TEXT PRIMARY KEY,            -- UUID v4
  from_address TEXT NOT NULL,        -- 송신자 DID (또는 'SYSTEM' for minting)
  to_address TEXT NOT NULL,          -- 수신자 DID
  amount INTEGER NOT NULL CHECK (amount > 0),
  fee INTEGER NOT NULL DEFAULT 0,    -- 정부 수수료 (마켓플레이스 2.5%)
  memo TEXT,                         -- 선택 메모
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('pending','confirmed','failed')),
  tx_type TEXT NOT NULL DEFAULT 'transfer'
    CHECK (tx_type IN ('transfer','mint','fee','escrow_lock','escrow_release','escrow_refund')),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS nova_escrows (
  escrow_id TEXT PRIMARY KEY,        -- UUID v4
  from_address TEXT NOT NULL,        -- 보내는 시민 DID
  to_address TEXT NOT NULL,          -- 받는 시민 DID
  amount INTEGER NOT NULL CHECK (amount > 0),
  condition TEXT,                    -- 해제 조건 설명 (자유 텍스트)
  status TEXT NOT NULL DEFAULT 'locked'
    CHECK (status IN ('locked','released','refunded','disputed')),
  arbiter TEXT,                      -- 중재자 DID (분쟁 시)
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_nova_tx_from ON nova_transactions(from_address);
CREATE INDEX IF NOT EXISTS idx_nova_tx_to ON nova_transactions(to_address);
CREATE INDEX IF NOT EXISTS idx_nova_tx_created ON nova_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nova_escrow_from ON nova_escrows(from_address);
CREATE INDEX IF NOT EXISTS idx_nova_escrow_status ON nova_escrows(status);

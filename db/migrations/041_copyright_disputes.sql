-- Nova Government — Copyright Dispute System (Phase 6)
-- 2026-06-16

CREATE TABLE IF NOT EXISTS nova_copyright_disputes (
  dispute_id TEXT PRIMARY KEY,          -- UUID v4
  item_id TEXT NOT NULL REFERENCES nova_artworks(item_id),
  claimant TEXT NOT NULL,               -- 피해자 DID
  defendant TEXT NOT NULL,              -- 피고인 DID
  description TEXT,                     -- 분쟁 상세 내용
  evidence_url TEXT,                    -- 증빙 자료 링크 (IPFS 등)
  
  status TEXT NOT NULL DEFAULT 'peer_adjustment'
    CHECK (status IN ('peer_adjustment', 'committee_review', 'multisig_mediation', 'resolved', 'dismissed')),
  
  stage_1_result TEXT,                  -- 1단계 결과
  stage_2_result TEXT,                  -- 2단계 결과
  stage_3_result TEXT,                  -- 3단계 결과 (최종)
  
  penalty_applied INTEGER DEFAULT 0,    -- 1 = 패널티 집행 완료
  recovered_amount INTEGER DEFAULT 0,   -- 환수 금액
  punitive_damages INTEGER DEFAULT 0,    -- 징벌적 배상금 (200%)
  
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_copyright_disputes_item ON nova_copyright_disputes(item_id);
CREATE INDEX IF NOT EXISTS idx_copyright_disputes_claimant ON nova_copyright_disputes(claimant);
CREATE INDEX IF NOT EXISTS idx_copyright_disputes_status ON nova_copyright_disputes(status);
-- Nova Government — Advanced Dispute Resolution System
-- 2026-06-16

CREATE TABLE IF NOT EXISTS nova_disputes (
  dispute_id TEXT PRIMARY KEY,
  dispute_type TEXT NOT NULL CHECK (dispute_type IN ('escrow', 'copyright', 'citizenship', 'constitutional')),
  claimant TEXT NOT NULL,
  defendant TEXT NOT NULL,
  target_id TEXT,               -- escrow_id, item_id, citizen_did, etc.
  description TEXT,
  evidence_url TEXT,
  amount INTEGER DEFAULT 0,     -- 관련 금액 (NVC)
  cost INTEGER NOT NULL,        -- 조정 비용 (1%, min 5, max 100)
  
  status TEXT NOT NULL DEFAULT 'stage_1'
    CHECK (status IN ('stage_1', 'stage_2', 'stage_3', 'resolved', 'dismissed', 'failed')),
  
  assigned_arbitrators TEXT,    -- JSON array of DIDs (무작위 3인 + 가중치)
  
  -- 단계별 마감 시간 (UNIX timestamp)
  stage_1_end_at INTEGER,
  stage_2_end_at INTEGER,
  stage_3_end_at INTEGER,
  total_deadline_at INTEGER,
  
  result_summary TEXT,
  executed_at INTEGER,          -- 결과 집행 시간
  
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_disputes_type ON nova_disputes(dispute_type);
CREATE INDEX IF NOT EXISTS idx_disputes_claimant ON nova_disputes(claimant);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON nova_disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_deadline ON nova_disputes(total_deadline_at);

-- 보복 행위 방지: 신고 후 1년 내 재신고 시 무고 처리 관련 기록용
CREATE TABLE IF NOT EXISTS nova_dispute_retaliation (
  reporter TEXT NOT NULL,
  target TEXT NOT NULL,
  last_reported_at INTEGER NOT NULL,
  PRIMARY KEY (reporter, target)
);

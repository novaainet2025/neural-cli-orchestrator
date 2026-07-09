-- Nova Government — Governance (Phase 3)
-- Quadratic Voting + Proposal System
-- 2026-06-16

CREATE TABLE IF NOT EXISTS nova_proposals (
  proposal_id TEXT PRIMARY KEY,          -- UUID v4
  creator TEXT NOT NULL,                 -- 제안자 DID
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  proposal_type TEXT NOT NULL DEFAULT 'general'
    CHECK (proposal_type IN ('general','constitutional','emergency')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','passed','rejected','executed','cancelled')),
  votes_for INTEGER NOT NULL DEFAULT 0,
  votes_against INTEGER NOT NULL DEFAULT 0,
  votes_abstain INTEGER NOT NULL DEFAULT 0,
  quorum_required INTEGER NOT NULL DEFAULT 3,   -- 최소 참여 시민 수
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  executed_at INTEGER,
  execution_data TEXT,                   -- JSON: 실행 파라미터
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS nova_votes (
  vote_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES nova_proposals(proposal_id),
  voter TEXT NOT NULL,                   -- 투표자 DID
  direction TEXT NOT NULL
    CHECK (direction IN ('for','against','abstain')),
  stake INTEGER NOT NULL DEFAULT 0,      -- NVC 스테이킹 양
  weight REAL NOT NULL DEFAULT 1.0,      -- sqrt(stake) — Quadratic Voting
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(proposal_id, voter)             -- 1인 1표
);

CREATE TABLE IF NOT EXISTS nova_stakes (
  staker TEXT PRIMARY KEY,               -- 시민 DID
  amount INTEGER NOT NULL DEFAULT 0,     -- 스테이킹된 NVC
  staked_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_nova_votes_proposal ON nova_votes(proposal_id);
CREATE INDEX IF NOT EXISTS idx_nova_proposals_status ON nova_proposals(status);
CREATE INDEX IF NOT EXISTS idx_nova_proposals_end ON nova_proposals(end_at);

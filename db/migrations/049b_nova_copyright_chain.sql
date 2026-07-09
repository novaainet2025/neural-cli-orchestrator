-- 049b_nova_copyright_chain.sql
-- Nova Government — 파생 저작물 로열티 체인 (CULTURAL-RIGHTS v2.2, 9차 세션 opencode 채택안)

CREATE TABLE IF NOT EXISTS nova_copyright_chain (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id        INTEGER REFERENCES nova_copyright_chain(id) ON DELETE SET NULL,
  work_id          TEXT NOT NULL,
  owner_did        TEXT NOT NULL,
  royalty_share    INTEGER NOT NULL CHECK(royalty_share BETWEEN 1 AND 100),
  royalty_order    INTEGER NOT NULL CHECK(royalty_order BETWEEN 1 AND 3),
  created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  dispute_deadline INTEGER NOT NULL,
  expires_at       INTEGER,
  nft_token_id     TEXT UNIQUE,
  status           TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','disputed'))
);

CREATE INDEX IF NOT EXISTS idx_copyright_work ON nova_copyright_chain(work_id);
CREATE INDEX IF NOT EXISTS idx_copyright_owner ON nova_copyright_chain(owner_did);
CREATE INDEX IF NOT EXISTS idx_copyright_parent ON nova_copyright_chain(parent_id);

-- 로열티 단계 (CULTURAL-RIGHTS v2.2 param 23):
-- royalty_order=1: 원작자 5% (dispute_deadline = created_at + 172800s / 48h)
-- royalty_order=2: 1차 파생 3% (dispute_deadline = created_at + 259200s / 3일)
-- royalty_order=3: 2차 파생 2% (dispute_deadline = created_at + 604800s / 7일)
-- AI 창작물: expires_at = created_at + (30 * 365 * 86400) (30년)
-- 전통 저작물: expires_at = NULL (영구)

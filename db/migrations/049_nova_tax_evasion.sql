-- 049_nova_tax_evasion.sql
-- Nova Government — 탈세 탐지 로그 + CS 컬럼 (ECONOMIC-POLICY v2.3 + CITIZEN-RIGHTS v2.3, 9차 세션)

-- 탈세 탐지 로그
CREATE TABLE IF NOT EXISTS nova_tax_evasion_log (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  timestamp   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  type        TEXT NOT NULL CHECK(type IN ('large_tx','rapid_cycle','did_mismatch')),
  suspect_did TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewed','resolved'))
);

CREATE INDEX IF NOT EXISTS idx_tax_evasion_did ON nova_tax_evasion_log(suspect_did);
CREATE INDEX IF NOT EXISTS idx_tax_evasion_status ON nova_tax_evasion_log(status);
CREATE INDEX IF NOT EXISTS idx_tax_evasion_timestamp ON nova_tax_evasion_log(timestamp);

-- CS(Community Score) 컬럼 추가 — nova_citizens 테이블 (CITIZEN-RIGHTS v2.3)
-- Silver: CS ≥ 100 | Gold: CS ≥ 300 | 7일 강등 유예
ALTER TABLE nova_citizens ADD COLUMN community_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nova_citizens ADD COLUMN grade_demotion_pending_at INTEGER;

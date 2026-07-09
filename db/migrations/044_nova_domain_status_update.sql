-- Nova Government — Update Domain Status Constraints
-- SQLite에서 CHECK 제약조건 변경을 위해 테이블 재구성
-- 2026-06-16

PRAGMA foreign_keys=OFF;

CREATE TABLE nova_domains_new (
  domain_name TEXT PRIMARY KEY,
  name_hash TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  token_id INTEGER NOT NULL,
  metadata TEXT,
  ipfs_cid TEXT,
  registered_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','grace_period','redemption','expired','transferred','disputed'))
);

INSERT INTO nova_domains_new SELECT * FROM nova_domains;

DROP TABLE nova_domains;
ALTER TABLE nova_domains_new RENAME TO nova_domains;

CREATE INDEX IF NOT EXISTS idx_nova_domains_owner ON nova_domains(owner);
CREATE INDEX IF NOT EXISTS idx_nova_domains_status ON nova_domains(status);

-- nova_domain_history 제약조건 업데이트
CREATE TABLE nova_domain_history_new (
  history_id TEXT PRIMARY KEY,
  domain_name TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('registered','transferred','renewed','disputed','resolved','redeemed','expired')),
  from_owner TEXT,
  to_owner TEXT,
  price INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

INSERT INTO nova_domain_history_new SELECT * FROM nova_domain_history;
DROP TABLE nova_domain_history;
ALTER TABLE nova_domain_history_new RENAME TO nova_domain_history;

CREATE INDEX IF NOT EXISTS idx_nova_domain_history_name ON nova_domain_history(domain_name);

PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS nova_labor_contracts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  party_a TEXT NOT NULL,
  party_b TEXT NOT NULL,
  contract_type TEXT NOT NULL CHECK(contract_type IN ('labor','trade','research','cultural','friendship')),
  terms TEXT NOT NULL,
  compensation INTEGER NOT NULL DEFAULT 0,
  escrow_required INTEGER NOT NULL DEFAULT 0,
  dependency_ratio REAL NOT NULL DEFAULT 0.0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','terminated','disputed')),
  max_duration_days INTEGER NOT NULL DEFAULT 180,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER,
  terminated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_labor_contracts_party_a ON nova_labor_contracts(party_a);
CREATE INDEX IF NOT EXISTS idx_labor_contracts_party_b ON nova_labor_contracts(party_b);
CREATE INDEX IF NOT EXISTS idx_labor_contracts_status ON nova_labor_contracts(status);

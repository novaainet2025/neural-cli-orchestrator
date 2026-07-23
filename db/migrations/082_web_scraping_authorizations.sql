-- 082: 웹 스크래핑 대상 승인 근거를 서버 측에서 조회·감사한다.

CREATE TABLE IF NOT EXISTS web_scraping_authorizations (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL,
  allowed_domain TEXT NOT NULL,
  purpose TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'revoked', 'expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(reference, allowed_domain)
);

CREATE INDEX IF NOT EXISTS idx_web_scraping_auth_reference
  ON web_scraping_authorizations(reference, status, expires_at);


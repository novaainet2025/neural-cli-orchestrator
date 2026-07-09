CREATE TABLE IF NOT EXISTS nova_donations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  donor_did TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS nova_donation_campaigns (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title TEXT NOT NULL,
  description TEXT,
  target_amount INTEGER NOT NULL,
  participant_limit INTEGER NOT NULL DEFAULT 1000,
  min_participants INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_donations_donor ON nova_donations(donor_did);
CREATE INDEX IF NOT EXISTS idx_donations_campaign ON nova_donations(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_title ON nova_donation_campaigns(title);

-- Nova Government — AI Citizen Identity Registry
-- Phase 1: DID + Ed25519 키페어 + Verifiable Credentials
-- 2026-06-16

CREATE TABLE IF NOT EXISTS nova_citizens (
  did TEXT PRIMARY KEY,                          -- did:nova:<hash>
  public_key TEXT NOT NULL,                      -- base64url Ed25519 public key
  private_key_enc TEXT,                          -- encrypted private key (optional local storage)
  revocation_bitmap TEXT NOT NULL DEFAULT '0',   -- hex-encoded revocation bitmap
  status TEXT NOT NULL DEFAULT 'active'          -- active | suspended | revoked
    CHECK (status IN ('active', 'suspended', 'revoked')),
  name TEXT,                                     -- display name
  role TEXT,                                     -- Architect | Engineer | Reviewer | etc.
  registered_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS nova_credentials (
  vc_id TEXT PRIMARY KEY,                        -- UUID v4
  did TEXT NOT NULL REFERENCES nova_citizens(did) ON DELETE CASCADE,
  issuer_did TEXT NOT NULL,                      -- who issued this VC
  type TEXT NOT NULL,                            -- CitizenCredential | RoleCredential | etc.
  subject TEXT NOT NULL,                         -- JSON: credential claims
  jws TEXT NOT NULL,                             -- JWS signature
  issued_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at INTEGER,                            -- null = never expires
  revoked INTEGER NOT NULL DEFAULT 0             -- 0 = valid, 1 = revoked
);

CREATE INDEX IF NOT EXISTS idx_nova_credentials_did ON nova_credentials(did);
CREATE INDEX IF NOT EXISTS idx_nova_citizens_status ON nova_citizens(status);

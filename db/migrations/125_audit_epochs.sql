-- Nova audit epochs — explicit recovery checkpoints for a compromised history.
--
-- This migration is deliberately metadata-only:
--   * existing audit rows, hash and prev_hash are never rewritten;
--   * every pre-epoch row is labelled "legacy" without changing its hash input;
--   * no recovery epoch is created automatically. An operator must use the
--     explicit audit epoch CLI and acknowledge the observed first invalid row.

ALTER TABLE nova_audit_log
  ADD COLUMN epoch_id TEXT NOT NULL DEFAULT 'legacy';

-- SQLite may renumber the hidden rowid during VACUUM. Persist the historical
-- Merkle order as metadata so checkpoint digests survive maintenance. This
-- column is intentionally not part of the legacy entry hash input.
ALTER TABLE nova_audit_log
  ADD COLUMN chain_seq INTEGER;

WITH ordered AS (
  SELECT rowid, ROW_NUMBER() OVER (ORDER BY timestamp ASC, rowid ASC) AS seq
  FROM nova_audit_log
)
UPDATE nova_audit_log
SET chain_seq = (SELECT seq FROM ordered WHERE ordered.rowid = nova_audit_log.rowid)
WHERE chain_seq IS NULL;

CREATE TABLE IF NOT EXISTS nova_audit_epochs (
  epoch_id TEXT PRIMARY KEY,
  sequence_no INTEGER NOT NULL UNIQUE CHECK (sequence_no > 0),
  created_at INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  incident_evidence TEXT NOT NULL CHECK (json_valid(incident_evidence)),
  expected_first_invalid_id TEXT NOT NULL,
  source_row_count INTEGER NOT NULL CHECK (source_row_count >= 0),
  source_max_chain_seq INTEGER NOT NULL CHECK (source_max_chain_seq >= 0),
  source_tip_rowid INTEGER NOT NULL CHECK (source_tip_rowid >= 0),
  source_tip_id TEXT,
  source_tip_hash TEXT,
  source_canonical_digest TEXT NOT NULL CHECK (length(source_canonical_digest) = 64),
  anchor_hash TEXT NOT NULL CHECK (length(anchor_hash) = 64),
  previous_checkpoint_hash TEXT NOT NULL CHECK (length(previous_checkpoint_hash) = 64),
  checkpoint_hash TEXT NOT NULL CHECK (length(checkpoint_hash) = 64)
);

CREATE INDEX IF NOT EXISTS idx_nova_audit_epoch_order
  ON nova_audit_log(epoch_id, chain_seq ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_nova_audit_chain_seq
  ON nova_audit_log(chain_seq)
  WHERE chain_seq IS NOT NULL;

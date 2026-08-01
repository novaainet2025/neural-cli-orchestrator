-- Provider assignments are pinned to the immutable provider registry view that
-- produced them. Existing rows predate revisioned registries and must never be
-- reused as if they were created from the current catalog.
ALTER TABLE provider_assignment_snapshots
  ADD COLUMN registry_revision TEXT NOT NULL DEFAULT 'legacy-unversioned';

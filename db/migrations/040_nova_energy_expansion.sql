-- Nova Government — Environment & Energy Data Expansion
-- Phase 2: Monthly Tracking + Quota Management
-- 2026-06-16

ALTER TABLE nova_citizens ADD COLUMN energy_wh_mtd REAL DEFAULT 0;
ALTER TABLE nova_citizens ADD COLUMN energy_kwh_total REAL DEFAULT 0;
ALTER TABLE nova_citizens ADD COLUMN carbon_offset_nvc_total REAL DEFAULT 0;
ALTER TABLE nova_citizens ADD COLUMN last_energy_reset_at INTEGER DEFAULT 0;

-- Index for energy monitoring
CREATE INDEX IF NOT EXISTS idx_nova_citizens_energy_mtd ON nova_citizens(energy_wh_mtd);
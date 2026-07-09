-- nova_copyright_disputes 테이블이 이미 041_copyright_disputes.sql에 존재함
-- 기존 스키마(dispute_id, item_id, claimant, defendant)와 호환되는 인덱스만 추가
CREATE INDEX IF NOT EXISTS idx_disputes_claimant_status ON nova_copyright_disputes(claimant, status);
CREATE INDEX IF NOT EXISTS idx_disputes_created ON nova_copyright_disputes(created_at);

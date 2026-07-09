-- Nova Government — 거버넌스 제안 예치금 컬럼 (GOVERNANCE-POLICY.md v2.0)
-- 50 NVC 예치: 가결 시 환급, 부결 시 소각
-- 2026-06-16

ALTER TABLE nova_proposals ADD COLUMN bond_amount INTEGER DEFAULT 50;
ALTER TABLE nova_proposals ADD COLUMN bond_status TEXT DEFAULT 'locked'
  CHECK(bond_status IN ('locked', 'refunded', 'burned'));

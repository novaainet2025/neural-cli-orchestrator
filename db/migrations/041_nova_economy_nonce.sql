-- Nova Government — Transaction Nonce Support
-- 이중지불 방지를 위한 Nonce 컬럼 추가
-- 2026-06-16

ALTER TABLE nova_transactions ADD COLUMN nonce TEXT;

-- 동일 Nonce 재사용 탐지를 위한 인덱스
CREATE INDEX IF NOT EXISTS idx_nova_tx_nonce ON nova_transactions(nonce);
CREATE INDEX IF NOT EXISTS idx_nova_tx_did_amount_time ON nova_transactions(from_address, amount, created_at);

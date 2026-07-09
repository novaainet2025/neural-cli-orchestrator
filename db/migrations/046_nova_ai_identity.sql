-- Nova Government — AI 시민 정체성 필드 (CITIZEN-REGISTRY.md v2.0)
-- model, provider, instanceId 3개 메타데이터 컬럼 추가
-- 2026-06-16

ALTER TABLE nova_citizens ADD COLUMN ai_model TEXT;
ALTER TABLE nova_citizens ADD COLUMN ai_provider TEXT;
ALTER TABLE nova_citizens ADD COLUMN ai_instance_id TEXT;

-- 인덱스: provider별 조회
CREATE INDEX IF NOT EXISTS idx_citizens_ai_provider ON nova_citizens(ai_provider);

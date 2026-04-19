-- Phase 3: 토큰 사용량 추적 (agent_invocations 확장)
-- 각 AI 호출의 토큰 소모량을 기록해 비용·효율 비교 분석 가능하게 함
-- 기존 레코드는 DEFAULT 0 으로 채워짐 (NULL 없음 — 집계 단순화)

ALTER TABLE agent_invocations ADD COLUMN prompt_tokens INTEGER DEFAULT 0;
ALTER TABLE agent_invocations ADD COLUMN completion_tokens INTEGER DEFAULT 0;
ALTER TABLE agent_invocations ADD COLUMN total_tokens INTEGER DEFAULT 0;
ALTER TABLE agent_invocations ADD COLUMN model TEXT;

CREATE INDEX IF NOT EXISTS idx_invoc_tokens
  ON agent_invocations(target_agent_id, total_tokens DESC);

CREATE INDEX IF NOT EXISTS idx_invoc_model
  ON agent_invocations(model, created_at DESC);

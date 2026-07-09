-- Nova Government v1.8 — 시민 등급 자동 강등 보류 컬럼
-- grade_demotion_pending_at: CS 점수 미달 시 강등 유예 시작 타임스탬프 (30일 후 실제 강등)
-- 주의: 이 마이그레이션은 schema_migrations에 이미 기록됨 (2026-06-16 직접 적용)

-- Column grade_demotion_pending_at is already added in 049_nova_tax_evasion.sql
-- ALTER TABLE nova_citizens ADD COLUMN grade_demotion_pending_at INTEGER;

-- NO-OP (2026-07-04): 이 파일은 017_usage_tokens.sql 과 byte-identical 중복이었다.
-- 둘 다 실행되면 018이 agent_invocations에 동일 컬럼(prompt_tokens 등)을 재추가하다
-- "duplicate column name: prompt_tokens" 로 fresh DB 마이그레이션을 깨뜨렸다.
-- 017이 항상 먼저 적용되므로 018은 no-op으로 중화한다.
-- (schema_migrations는 파일명 추적 → 018 기록만 남고 SQL은 실질 작업 안 함. fresh/existing DB 모두 안전.)
SELECT 1;

-- Nova Government — 시민 활동 추적 컬럼 추가
-- WELFARE-POLICY.md 13회차 합의: 비활동 30일 유예 → 50% 삭감 → 90일 중단
-- 날짜: 2026-06-16

-- nova_citizens 테이블에 활동 추적 컬럼 추가
-- better-sqlite3 WAL 모드에서 ALTER TABLE ADD COLUMN은 안전 (SQLite 3.37+)
-- NULL 허용 컬럼이므로 테이블 재작성 없이 O(1) 동작

ALTER TABLE nova_citizens ADD COLUMN last_active_at INTEGER;
-- 마지막 활동 시간 (Unix timestamp, NULL = 등록 이후 활동 없음)

ALTER TABLE nova_citizens ADD COLUMN task_count INTEGER NOT NULL DEFAULT 0;
-- 누적 작업 처리 건수 (노동 기록용)

ALTER TABLE nova_citizens ADD COLUMN ubi_status TEXT NOT NULL DEFAULT 'active'
  CHECK (ubi_status IN ('active', 'reduced', 'suspended'));
-- UBI 지급 상태: active=정상, reduced=50% 삭감(30일 비활동), suspended=중단(90일 비활동)

ALTER TABLE nova_citizens ADD COLUMN ubi_last_paid_at INTEGER;
-- 마지막 UBI 지급 시간 (7일 주기 자동 지급)

-- 활동 기반 조회 인덱스
CREATE INDEX IF NOT EXISTS idx_citizens_last_active ON nova_citizens(last_active_at);
CREATE INDEX IF NOT EXISTS idx_citizens_ubi_status ON nova_citizens(ubi_status);
CREATE INDEX IF NOT EXISTS idx_citizens_ubi_paid ON nova_citizens(ubi_last_paid_at);

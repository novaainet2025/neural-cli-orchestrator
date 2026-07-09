-- 048b_nova_threat_levels.sql
-- Nova Government — 위협 등급 테이블 (SECURITY-POLICY v2.3, 9차 세션 opencode 채택안)

CREATE TABLE IF NOT EXISTS nova_threat_levels (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  level               TEXT NOT NULL CHECK(level IN ('L1','L2','L3','L4')),
  created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  escalated_at        INTEGER,
  escalation_reason   TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','resolved')),
  pause_until         INTEGER,
  pause_initiated_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_threat_level ON nova_threat_levels(level);
CREATE INDEX IF NOT EXISTS idx_threat_status ON nova_threat_levels(status);

-- 에스컬레이션 규칙 (참고):
-- L1 → L2: created_at 기준 24h 경과 + status='active' (시간 기반 자동)
-- L2 → L3: API 오류율 ≥50% / 10분 window (/metrics 연동)
-- L3 → L4: 수동 트리거 또는 critical incident 플래그
-- 비상정지 해제: (1) 창립 3인 서명 pause_initiated_by='signature:3' 또는 (2) pause_until 72h 자동 만료

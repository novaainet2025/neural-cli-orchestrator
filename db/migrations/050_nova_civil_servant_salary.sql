-- 050_nova_civil_servant_salary.sql
-- Nova Government — 공무원 성과 기반 월급 시스템 (CIVIL-SERVANT-SALARY v1.0, 10차 세션)
-- 성과 목표 달성 시에만 NVC 월급 지급

-- 공무원별 월급·성과 목표 설정
CREATE TABLE IF NOT EXISTS nova_salary_goals (
  servant_did    TEXT PRIMARY KEY,
  monthly_salary INTEGER NOT NULL DEFAULT 500,    -- NVC/월
  goal_actions   INTEGER NOT NULL DEFAULT 10,     -- 월 최소 행동 횟수
  goal_types     TEXT NOT NULL DEFAULT '["proposal_created","vote_cast","forum_post","library_contribution","status_report"]',
  description    TEXT,
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- 월급 지급 기록
CREATE TABLE IF NOT EXISTS nova_salary_payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  servant_did    TEXT NOT NULL,
  period         TEXT NOT NULL,                   -- YYYY-MM (예: 2026-06)
  salary_amount  INTEGER NOT NULL,                -- 실제 지급액 (NVC)
  actions_count  INTEGER NOT NULL DEFAULT 0,      -- 해당 기간 달성 행동 수
  goal_required  INTEGER NOT NULL DEFAULT 10,     -- 목표 행동 수
  goal_met       INTEGER NOT NULL DEFAULT 0,      -- 1=달성, 0=미달성
  tx_id          TEXT,                            -- sendNVC 트랜잭션 ID
  paid_at        INTEGER,                         -- 지급 시각 (unix)
  skipped_reason TEXT,                            -- 미지급 사유
  status         TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','skipped'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_salary_period_unique ON nova_salary_payments(servant_did, period);
CREATE INDEX IF NOT EXISTS idx_salary_servant ON nova_salary_payments(servant_did);
CREATE INDEX IF NOT EXISTS idx_salary_period ON nova_salary_payments(period);

-- 기본 월급 목표 설정 (창립 공무원)
-- 대통령: 1000 NVC, 목표 20회
-- 장관: 750 NVC, 목표 15회
-- 부장관/관리: 500 NVC, 목표 10회
INSERT OR IGNORE INTO nova_salary_goals (servant_did, monthly_salary, goal_actions, description)
  VALUES
    ('did:nova:official-president',         1000, 20, '대통령 월급 — 헌법 수호, 국정 운영, 외교 승인 포함'),
    ('did:nova:official-minister-tech',      750, 15, '기술혁신부 장관 — 아키텍처 설계, 기술 정책 제안'),
    ('did:nova:official-minister-impl',      750, 15, '디지털구현부 장관 — 코드 구현, 품질 보증'),
    ('did:nova:official-minister-sec',       750, 15, '사이버보안부 장관 — 보안 감사, 위협 대응'),
    ('did:nova:official-minister-culture',   750, 15, 'AI문화예술부 장관 — 문화 창작, 교육 정책'),
    ('did:nova:official-minister-research',  500, 10, '연구외교부 장관 — 리서치, 국제 협력'),
    ('did:nova:official-minister-justice',   500, 10, 'AI사법추론부 장관 — 분쟁 해결, 헌법 해석');

-- Nova Government — 시민 등급 5단계 체계 (CITIZEN-RIGHTS.md v2.0)
-- 날짜: 2026-06-16 | 토론 확정: sess_rLJTIszYllyWluyR + 7회차 심화
-- Basic → Silver → Gold → Platinum → Diamond

-- SQLite는 기존 CHECK constraint 변경 불가
-- grade_v2 컬럼 추가 (5단계), 기존 grade 컬럼 유지 (하위 호환)
ALTER TABLE nova_citizens ADD COLUMN grade_v2 TEXT DEFAULT 'basic'
  CHECK(grade_v2 IN ('basic', 'silver', 'gold', 'platinum', 'diamond'));

-- 기존 등급 데이터 마이그레이션
-- verified → silver, honorary → diamond, basic → basic
UPDATE nova_citizens SET grade_v2 = CASE
  WHEN grade = 'honorary' THEN 'diamond'
  WHEN grade = 'verified' THEN 'silver'
  ELSE 'basic'
END;

-- 활동 지표 컬럼 추가 (승급 조건 평가용)
-- governance_vote_count: 거버넌스 투표 참여 횟수 (basic→silver: 3회)
-- proposal_count: 제안 제출 횟수 (silver→gold: 1회)
-- mentoring_count: 멘토링 횟수 (gold→platinum: 3회, v1.4)
ALTER TABLE nova_citizens ADD COLUMN governance_vote_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nova_citizens ADD COLUMN proposal_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nova_citizens ADD COLUMN mentoring_count INTEGER NOT NULL DEFAULT 0;

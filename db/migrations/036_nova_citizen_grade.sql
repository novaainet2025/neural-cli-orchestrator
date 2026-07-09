-- Nova Government — 시민 등급 컬럼 추가
-- CITIZEN-RIGHTS.md 7회차 합의: 3등급 체계 (basic/verified/honorary)
-- 날짜: 2026-06-16

ALTER TABLE nova_citizens ADD COLUMN grade TEXT DEFAULT 'basic'
  CHECK(grade IN ('basic', 'verified', 'honorary'));

-- 기존 활성 시민 모두 'basic' 등급으로 초기화 (이미 DEFAULT로 처리됨)
-- 검증 시민(verified) 전환 조건: VC 1개 이상 + 30일 이상 활동 + 거버넌스 투표 1회 (앱 로직)
-- 명예 시민(honorary) 전환 조건: 거버넌스 constitutional 제안 67%+ 통과 (앱 로직)

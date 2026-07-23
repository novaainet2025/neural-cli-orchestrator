-- 076: teams/organizations 스케줄(cron) 필드 — 대시보드 타이머 정확 표시용.
-- 의미: schedule = 5-field cron 표현식. 값이 있으면 그 cron이 해당 엔티티의 실제 예약이다.
--       NULL = 기본 업무보고 슬롯(오전 11:30 · 오후 18:00 KST, work-report-scheduler)로 폴백.
-- 배경: nco-self개선 회사의 "1시간마다 체크"는 system crontab '20 * * * *'(self-improve/run-checks.sh)로
--       실행되지만 DB org/team 엔티티와 연결이 없어 대시보드가 표시하지 못했다. 이 필드로 단일 소스화한다.

ALTER TABLE teams ADD COLUMN schedule TEXT;
ALTER TABLE organizations ADD COLUMN schedule TEXT;

-- nco-self개선 회사: 매시 20분 (system crontab '20 * * * *' 반영)
UPDATE organizations SET schedule = '20 * * * *', updated_at = datetime('now') WHERE id = 'org_nco-self';

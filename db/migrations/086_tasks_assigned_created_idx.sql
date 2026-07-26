-- 086: tasks(assigned_to, status, created_at) 커버링 인덱스
-- 배경(2026-07-26): /api/agents의 last-fail 쿼리가 상관 서브쿼리로 8.6초 소요 →
-- 대시보드 폴링 적체로 이벤트 루프 포화(전체 HTTP 타임아웃). 쿼리는 CTE로 재작성했고,
-- 이 인덱스는 agent별 MAX(created_at)/최근-실패 집계 계열 쿼리를 인덱스만으로 처리하는 방어층.
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_status_created
  ON tasks(assigned_to, status, created_at);

-- P0-7: 재발행 루프 측정 오염 제거 — work_reports당 재발행 시도 상한(5) + 지수 백오프.
-- 근거: CB 실패 2,077행이 단 149개 업무보고에서 발생(평균 13.9배, 최다 89회) — 실패한
-- 보고가 매 틱 무제한 재발행되어 같은 근본원인이 반복 카운트됨. redispatch_attempts로
-- 상한을 걸고, next_redispatch_at으로 백오프 창이 지나기 전엔 재시도하지 않는다.
ALTER TABLE work_reports ADD COLUMN redispatch_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_reports ADD COLUMN next_redispatch_at TEXT;

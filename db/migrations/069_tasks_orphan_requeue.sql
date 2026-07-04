-- 069: orphan 재시작 재큐잉 카운터 (poison task 무한 재큐잉 방지)
-- 부팅 시 in-flight 태스크를 failed로 종결하는 대신 최대 N회 재큐잉하고,
-- N회 초과 시에만 dead-letter 처리한다. (task 실패 근본해결 A단계)
ALTER TABLE tasks ADD COLUMN orphan_requeue_count INTEGER NOT NULL DEFAULT 0;

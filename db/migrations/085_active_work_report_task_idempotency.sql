-- 동일 업무보고의 동시 재발행은 큐 포화와 실패 증폭을 일으킨다.
-- 활성 태스크에만 고유성을 적용해 실패·취소·시간초과 뒤 재시도는 허용한다.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_work_report_id
  ON tasks(json_extract(metadata_json, '$.workReportId'))
  WHERE json_valid(metadata_json)
    AND json_extract(metadata_json, '$.workReportId') IS NOT NULL
    AND TRIM(json_extract(metadata_json, '$.workReportId')) != ''
    AND status IN ('pending','queued','assigned','running','streaming','reviewing');

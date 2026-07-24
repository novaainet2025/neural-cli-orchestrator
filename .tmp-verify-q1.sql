SELECT id, event_type, created_at,
  json_extract(metadata_json,'$.score') as score,
  json_extract(metadata_json,'$.completion') as completion,
  json_extract(metadata_json,'$.n') as n,
  json_extract(metadata_json,'$.sample') as sample
FROM team_lifecycle_events
WHERE team_id='team_quality-audit'
  AND event_type IN ('score_checked','hr_directive')
ORDER BY created_at DESC LIMIT 12;

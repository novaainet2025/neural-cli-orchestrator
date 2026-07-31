import Database from 'better-sqlite3';
const db = new Database('db/nco.db', { readonly: true });
const rows = db.prepare(`
  SELECT k.id, k.assigned_to, k.status, k.error, k.created_at, k.completed_at,
         LENGTH(COALESCE(k.response,'')) AS rlen,
         LENGTH(COALESCE(k.result_json,'')) AS jlen,
         k.spawned_by_cli,
         json_extract(k.metadata_json,'$.workReportId') AS wrid,
         k.acked_at, k.last_heartbeat_at, k.lease_expires_at,
         dwr.wrid AS dwr, awr.wrid AS awr, ff.wrid AS ff
  FROM tasks k
  LEFT JOIN (SELECT DISTINCT team_id, json_extract(metadata_json,'$.workReportId') AS wrid FROM tasks
    WHERE status='completed' AND json_valid(metadata_json) AND TRIM(COALESCE(json_extract(metadata_json,'$.workReportId'),''))<>'') dwr
    ON dwr.team_id=k.team_id AND dwr.wrid=json_extract(k.metadata_json,'$.workReportId')
  LEFT JOIN (SELECT DISTINCT team_id, json_extract(metadata_json,'$.workReportId') AS wrid FROM tasks
    WHERE status IN ('pending','queued','assigned','running','streaming','reviewing') AND json_valid(metadata_json) AND TRIM(COALESCE(json_extract(metadata_json,'$.workReportId'),''))<>'') awr
    ON awr.team_id=k.team_id AND awr.wrid=json_extract(k.metadata_json,'$.workReportId')
  LEFT JOIN (SELECT team_id, json_extract(metadata_json,'$.workReportId') AS wrid FROM tasks
    WHERE status IN ('failed','timed_out','lease_expired') AND json_valid(metadata_json) AND TRIM(COALESCE(json_extract(metadata_json,'$.workReportId'),''))<>''
    GROUP BY team_id, json_extract(metadata_json,'$.workReportId') HAVING COUNT(*)>1) ff
    ON ff.team_id=k.team_id AND ff.wrid=json_extract(k.metadata_json,'$.workReportId')
  WHERE k.team_id='team_hr-director'
    AND k.status IN ('completed','failed','timed_out','lease_expired')
    AND julianday(k.created_at) >= julianday('now','-48 hours')
  ORDER BY k.created_at DESC
`).all();
for (const r of rows) console.log(JSON.stringify(r));
console.log('raw terminal count:', rows.length);

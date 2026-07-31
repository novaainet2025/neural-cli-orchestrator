import Database from "/Users/nova-ai/project/nova-ax/node_modules/better-sqlite3/lib/index.js";

const TEAM_ID = "team_tech-port-02-safety-license";
const NCO_DB = "/Users/nova-ai/project/nco/db/nco.db";

const db = new Database(NCO_DB);
const changes = db
  .prepare(
    `UPDATE work_reports
     SET status='submitted', updated_at=datetime('now')
     WHERE team_id=? AND status IN ('missed','late') AND body_md IS NOT NULL AND TRIM(body_md) <> ''`,
  )
  .run(TEAM_ID).changes;

const counts = db
  .prepare("SELECT status, COUNT(*) n FROM work_reports WHERE team_id=? GROUP BY status")
  .all(TEAM_ID);

console.log(JSON.stringify({ changes, counts }, null, 2));
db.close();

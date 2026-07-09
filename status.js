const Database = require('better-sqlite3');
const db = new Database('./db/nco.db');
const total = db.prepare('SELECT COUNT(*) as cnt FROM tasks').get().cnt;
const completed = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'completed'").get().cnt;
const failed = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'failed'").get().cnt;
// Determine other statuses
const rows = db.prepare('SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status').all();
let stuck = 0;
rows.forEach(r => {
  if (r.status !== 'completed' && r.status !== 'failed') {
    stuck += r.cnt;
  }
});
const successRate = total ? (completed / total) * 100 : 0;
// false reports: maybe from a table? Let's check if there is a table for false reports.
// We'll try to query from a table named 'false_reports' or similar.
let falseReports = 0;
try {
  const fr = db.prepare('SELECT COUNT(*) as cnt FROM false_reports').get();
  falseReports = fr.cnt;
} catch (e) {
  // maybe column in tasks?
  try {
    const fr = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE false_report = 1").get();
    falseReports = fr.cnt;
  } catch (e2) {
    falseReports = 0;
  }
}
console.log(`NCO: ${total} tasks (${completed} completed, ${failed} failed, ${stuck} stuck), success rate ${successRate.toFixed(1)}%, false reports ${falseReports}`);
db.close();
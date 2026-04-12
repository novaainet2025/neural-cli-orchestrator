import Database from 'better-sqlite3';

const db = new Database('./db/nco.db');
const row = db.prepare('SELECT content FROM agent_messages ORDER BY created_at DESC LIMIT 1').get() as any;

if (row) {
  console.log('--- LATEST MESSAGE ---');
  console.log(row.content);
}
db.close();

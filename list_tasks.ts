import Database from 'better-sqlite3';

const db = new Database('./db/nco.db');
const tasks = db.prepare('SELECT id, status, prompt FROM tasks LIMIT 10').all() as any[];

console.log('--- ALL TASKS ---');
tasks.forEach(t => {
  console.log(`[${t.id}] ${t.status}: ${t.prompt.substring(0, 50)}...`);
});
db.close();

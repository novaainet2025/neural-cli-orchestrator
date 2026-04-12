import Database from 'better-sqlite3';
import { resolve } from 'path';

const db = new Database('./db/nco.db');
const row = db.prepare('SELECT id, prompt FROM tasks WHERE id = ?').get('task_nHHUQekVcSDTILfC') as any;

if (row) {
  console.log('--- TASK START ---');
  console.log(row.prompt);
  console.log('--- TASK END ---');
} else {
  console.log('Task not found.');
}
db.close();

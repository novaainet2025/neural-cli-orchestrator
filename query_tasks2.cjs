const Database = require('better-sqlite3');
const db = new Database('./db/nco.db');
const rows = db.prepare('SELECT id, status, prompt FROM tasks WHERE prompt LIKE ? AND prompt LIKE ?').all('%NOVA-VOICE%', '%Quick Win%');
console.log(JSON.stringify(rows, null, 2));
db.close();
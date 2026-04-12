import Database from 'better-sqlite3';

const db = new Database('./db/nco.db');
const tables = ['tasks', 'discussions', 'agent_actions', 'agent_sessions', 'agent_messages', 'artifacts'];

tables.forEach(table => {
  try {
    const rows = db.prepare(`SELECT id FROM ${table} ORDER BY created_at DESC LIMIT 5`).all() as any[];
    console.log(`--- Table: ${table} ---`);
    rows.forEach(r => console.log(r.id));
  } catch (e) {
    console.log(`Error reading ${table}`);
  }
});
db.close();

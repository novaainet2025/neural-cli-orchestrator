import Database from 'better-sqlite3';

const db = new Database('./db/nco.db');
const msgs = db.prepare('SELECT id, from_agent, content FROM agent_messages ORDER BY created_at DESC LIMIT 5').all() as any[];

console.log('--- RECENT MESSAGES ---');
msgs.forEach(m => {
  console.log(`[${m.from_agent}] ${m.content.substring(0, 100)}...`);
});
db.close();

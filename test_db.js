const Database = require('better-sqlite3');
const db = new Database('data/nco.db');
console.log(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'").get());

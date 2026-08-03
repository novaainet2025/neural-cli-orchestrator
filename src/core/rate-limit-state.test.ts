import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { isAgentActivelyRateLimited, listActivelyRateLimited } from './rate-limit-state.js';

describe('active rate-limit state', () => {
  it('only gates rows with a future reset time', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE rate_limit_state (
        agent_id TEXT PRIMARY KEY,
        is_limited INTEGER NOT NULL,
        reset_at TEXT
      );
      INSERT INTO rate_limit_state VALUES
        ('future', 1, datetime('now', '+1 hour')),
        ('expired', 1, datetime('now', '-1 hour')),
        ('iso-future', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour')),
        ('iso-expired', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')),
        ('legacy-null', 1, NULL),
        ('clear', 0, datetime('now', '+1 hour'));
    `);

    expect([...listActivelyRateLimited(db)]).toEqual(['future', 'iso-future']);
    expect(isAgentActivelyRateLimited(db, 'future')).toBe(true);
    expect(isAgentActivelyRateLimited(db, 'expired')).toBe(false);
    expect(isAgentActivelyRateLimited(db, 'iso-future')).toBe(true);
    expect(isAgentActivelyRateLimited(db, 'iso-expired')).toBe(false);
    expect(isAgentActivelyRateLimited(db, 'legacy-null')).toBe(false);
    expect(isAgentActivelyRateLimited(db, 'clear')).toBe(false);
    db.close();
  });
});

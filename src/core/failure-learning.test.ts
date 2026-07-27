import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./decision-log.js', () => ({ logDecision: vi.fn() }));
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  getFailureDigest,
  getLearnedCircuitPatterns,
  invalidateLearnedCircuitPattern,
  matchLearnedCircuitPattern,
  normalizeCircuitSignature,
  recordLearnedCircuitPatternApplication,
  recordLearningEvent,
} from './failure-learning.js';

describe('failure learning writer and consumer', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE learning_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        event_type TEXT,
        pattern TEXT,
        context TEXT,
        auto_applied INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('writes learning_events rows and includes them in the failure digest', () => {
    const id = recordLearningEvent({
      agentId: 'codex',
      eventType: 'failover_skip',
      pattern: 'failover_exhausted',
      context: { taskId: 'task-1' },
    }, db);

    expect(id).toBe(1);
    expect(db.prepare(`
      SELECT agent_id, event_type, pattern, context, auto_applied
      FROM learning_events
    `).get()).toEqual({
      agent_id: 'codex',
      event_type: 'failover_skip',
      pattern: 'failover_exhausted',
      context: '{"taskId":"task-1"}',
      auto_applied: 0,
    });
    expect(getFailureDigest(db).totals).toContainEqual({
      eventType: 'failover_skip',
      count: 1,
      autoApplied: 0,
      lastSeen: expect.any(String),
    });
  });

  it('promotes only three complete identical signatures and audits application', () => {
    const signature = 'Provider credits depleted for this workspace';
    for (let index = 0; index < 2; index++) {
      recordLearningEvent({
        agentId: 'provider-a',
        eventType: 'circuit_unclassified',
        pattern: signature,
      }, db);
    }
    expect(getLearnedCircuitPatterns(db)).toEqual([]);

    recordLearningEvent({
      agentId: 'provider-a',
      eventType: 'circuit_unclassified',
      pattern: signature,
    }, db);
    const learned = getLearnedCircuitPatterns(db);
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({
      signature,
      sourceCount: 3,
      reason: 'generic',
      immediateOpen: false,
      failureThreshold: 2,
    });
    expect(learned[0].regex.test(signature)).toBe(true);
    expect(learned[0].regex.test(`prefix ${signature}`)).toBe(false);
    expect(learned[0].regex.test(`${signature} suffix`)).toBe(false);
    expect(learned[0].regex.test(signature.toLowerCase())).toBe(false);

    const matched = matchLearnedCircuitPattern(signature, db);
    expect(matched?.signature).toBe(signature);
    recordLearnedCircuitPatternApplication('provider-a', matched!, db);
    expect(db.prepare(`
      SELECT event_type, pattern, auto_applied, context
      FROM learning_events
      WHERE event_type='circuit_pattern_auto_applied'
    `).get()).toEqual({
      event_type: 'circuit_pattern_auto_applied',
      pattern: signature,
      auto_applied: 1,
      context: JSON.stringify({
        sourceCount: 3,
        matchMode: 'full_signature',
        promotedReason: 'generic',
        immediateOpen: false,
        failureThreshold: 2,
      }),
    });
  });

  it('promotes repeated transient signatures without quota or immediate-open semantics', () => {
    const signature = 'ECONNRESET';
    for (let index = 0; index < 3; index++) {
      recordLearningEvent({
        agentId: 'provider-transient',
        eventType: 'circuit_unclassified',
        pattern: signature,
      }, db);
    }

    expect(matchLearnedCircuitPattern(signature, db)).toMatchObject({
      signature,
      reason: 'generic',
      immediateOpen: false,
      failureThreshold: 2,
    });
  });

  it('supports audited manual invalidation and requires three new observations to relearn', () => {
    const signature = 'Billing window unavailable';
    for (let index = 0; index < 3; index++) {
      recordLearningEvent({
        agentId: 'provider-b',
        eventType: 'circuit_unclassified',
        pattern: signature,
      }, db);
    }
    expect(getLearnedCircuitPatterns(db)).toHaveLength(1);

    expect(invalidateLearnedCircuitPattern(signature, {
      actor: 'nco-admin',
      reason: 'false positive confirmed',
    }, db)).toBe(true);
    expect(getLearnedCircuitPatterns(db)).toEqual([]);
    expect(db.prepare(`
      SELECT agent_id, event_type, pattern, context
      FROM learning_events
      WHERE event_type='circuit_pattern_invalidated'
    `).get()).toEqual({
      agent_id: 'nco-admin',
      event_type: 'circuit_pattern_invalidated',
      pattern: signature,
      context: JSON.stringify({
        actor: 'nco-admin',
        reason: 'false positive confirmed',
      }),
    });

    for (let index = 0; index < 2; index++) {
      recordLearningEvent({
        agentId: 'provider-b',
        eventType: 'circuit_unclassified',
        pattern: signature,
      }, db);
    }
    expect(getLearnedCircuitPatterns(db)).toEqual([]);

    recordLearningEvent({
      agentId: 'provider-b',
      eventType: 'circuit_unclassified',
      pattern: signature,
    }, db);
    expect(getLearnedCircuitPatterns(db)).toHaveLength(1);
  });

  it('rejects empty and truncated signatures instead of learning partial matches', () => {
    expect(normalizeCircuitSignature('  exact error  ')).toBe('exact error');
    expect(normalizeCircuitSignature('')).toBeNull();
    expect(normalizeCircuitSignature('x'.repeat(501))).toBeNull();
  });
});

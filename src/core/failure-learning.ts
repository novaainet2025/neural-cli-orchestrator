import type Database from 'better-sqlite3';
import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';
import { logDecision } from './decision-log.js';

const log = createLogger('failure-learning');

export const LEARNING_WINDOW_DAYS = 14;
export const LEARNING_PROMOTION_COUNT = 3;
export const LEARNED_FAILURE_THRESHOLD = 2;
export const MAX_CIRCUIT_SIGNATURE_CHARS = 500;
const LEARNED_PATTERN_CACHE_TTL_MS = 60_000;

export type LearningEventType =
  | 'circuit_commit'
  | 'circuit_unclassified'
  | 'circuit_pattern_auto_applied'
  | 'circuit_pattern_invalidated'
  | 'failover_skip'
  | 'failover_dispatch'
  | 'quality_reject'
  | 'escalation'
  | 'orphan_poison'
  | 'duplicate_execution';

export interface LearningEventInput {
  agentId: string;
  eventType: LearningEventType;
  pattern?: string | null;
  context?: string | Record<string, unknown> | null;
  autoApplied?: boolean;
}

export interface LearnedCircuitPattern {
  signature: string;
  sourceCount: number;
  firstSeen: string;
  lastSeen: string;
  regex: RegExp;
  reason: 'generic' | 'rate-limit' | 'quota' | 'auth';
  immediateOpen: boolean;
  failureThreshold: number;
}

export interface FailureDigest {
  generatedAt: string;
  windowDays: number;
  totals: Array<{
    eventType: string;
    count: number;
    autoApplied: number;
    lastSeen: string;
  }>;
  learnedCircuitPatterns: Array<Omit<LearnedCircuitPattern, 'regex'>>;
}

let learnedPatternCache:
  | { expiresAt: number; patterns: LearnedCircuitPattern[] }
  | null = null;

function contextJson(context: LearningEventInput['context']): string | null {
  if (context == null) return null;
  return typeof context === 'string' ? context : JSON.stringify(context);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deliberately performs no fuzzy normalization. Promotion is allowed only when
 * the complete, trimmed provider error repeats byte-for-byte (apart from CRLF).
 * Long outputs are rejected rather than truncated, because truncation would
 * turn a prefix into an unsafe broad signature.
 */
export function normalizeCircuitSignature(
  raw: string | null | undefined,
): string | null {
  const signature = raw?.trim().replaceAll('\r\n', '\n');
  if (!signature || signature.length > MAX_CIRCUIT_SIGNATURE_CHARS) return null;
  return signature;
}

export function clearLearningPatternCache(): void {
  learnedPatternCache = null;
}

export function recordLearningEvent(
  input: LearningEventInput,
  db?: Database.Database,
): number | null {
  try {
    const database = db ?? getDb();
    const result = database.prepare(`
      INSERT INTO learning_events
        (agent_id, event_type, pattern, context, auto_applied)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.agentId,
      input.eventType,
      input.pattern ?? null,
      contextJson(input.context),
      input.autoApplied ? 1 : 0,
    );
    if (
      input.eventType === 'circuit_unclassified'
      || input.eventType === 'circuit_pattern_invalidated'
    ) {
      clearLearningPatternCache();
    }
    return Number(result.lastInsertRowid);
  } catch (error) {
    log.warn({
      agentId: input.agentId,
      eventType: input.eventType,
      error: error instanceof Error ? error.message : String(error),
    }, 'Failed to record learning event');
    return null;
  }
}

function readLearnedCircuitPatterns(
  db: Database.Database,
): LearnedCircuitPattern[] {
  const rows = db.prepare(`
    WITH invalidations AS (
      SELECT pattern, MAX(id) AS invalidated_id
      FROM learning_events
      WHERE event_type='circuit_pattern_invalidated'
        AND pattern IS NOT NULL
      GROUP BY pattern
    )
    SELECT
      candidate.pattern AS signature,
      COUNT(*) AS source_count,
      MIN(candidate.created_at) AS first_seen,
      MAX(candidate.created_at) AS last_seen
    FROM learning_events AS candidate
    LEFT JOIN invalidations
      ON invalidations.pattern = candidate.pattern
    WHERE candidate.event_type='circuit_unclassified'
      AND candidate.pattern IS NOT NULL
      AND candidate.created_at >= datetime('now', '-${LEARNING_WINDOW_DAYS} days')
      AND (
        invalidations.invalidated_id IS NULL
        OR candidate.id > invalidations.invalidated_id
      )
    GROUP BY candidate.pattern
    HAVING COUNT(*) >= ${LEARNING_PROMOTION_COUNT}
    ORDER BY source_count DESC, last_seen DESC, signature ASC
  `).all() as Array<{
    signature: string;
    source_count: number;
    first_seen: string;
    last_seen: string;
  }>;

  return rows.flatMap((row) => {
    const signature = normalizeCircuitSignature(row.signature);
    if (!signature) return [];
    return [{
      signature,
      sourceCount: Number(row.source_count),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      regex: new RegExp(`^${escapeRegExp(signature)}$`, 'u'),
      // Only errors that did not match an explicit provider pattern are
      // recorded as circuit_unclassified, so promotion must preserve them as
      // generic failures. Two consecutive matches open the circuit: this is
      // protective compared with the default threshold of three, but still
      // avoids immediate-open false positives for transient errors.
      reason: 'generic',
      immediateOpen: false,
      failureThreshold: LEARNED_FAILURE_THRESHOLD,
    }];
  });
}

export function getLearnedCircuitPatterns(
  db?: Database.Database,
  now = Date.now(),
): LearnedCircuitPattern[] {
  if (!db && learnedPatternCache && learnedPatternCache.expiresAt > now) {
    return learnedPatternCache.patterns;
  }

  try {
    const patterns = readLearnedCircuitPatterns(db ?? getDb());
    if (!db) {
      learnedPatternCache = {
        expiresAt: now + LEARNED_PATTERN_CACHE_TTL_MS,
        patterns,
      };
    }
    return patterns;
  } catch (error) {
    log.warn({
      error: error instanceof Error ? error.message : String(error),
    }, 'Failed to read learned circuit patterns');
    return [];
  }
}

export function matchLearnedCircuitPattern(
  raw: string | null | undefined,
  db?: Database.Database,
): LearnedCircuitPattern | null {
  const signature = normalizeCircuitSignature(raw);
  if (!signature) return null;
  return getLearnedCircuitPatterns(db)
    .find((candidate) => candidate.regex.test(signature)) ?? null;
}

export function recordLearnedCircuitPatternApplication(
  agentId: string,
  learned: LearnedCircuitPattern,
  db?: Database.Database,
): void {
  recordLearningEvent({
    agentId,
    eventType: 'circuit_pattern_auto_applied',
    pattern: learned.signature,
    context: {
      sourceCount: learned.sourceCount,
      matchMode: 'full_signature',
      promotedReason: learned.reason,
      immediateOpen: learned.immediateOpen,
      failureThreshold: learned.failureThreshold,
    },
    autoApplied: true,
  }, db);
  logDecision({
    phase: 'failure-learning',
    decision: 'circuit-pattern:auto-apply',
    reason: learned.signature,
    evidenceTier: 'T1',
    actor: agentId,
  });
}

export function invalidateLearnedCircuitPattern(
  pattern: string,
  options: { actor?: string; reason?: string } = {},
  db?: Database.Database,
): boolean {
  const signature = normalizeCircuitSignature(pattern);
  if (!signature) return false;

  try {
    const database = db ?? getDb();
    const exists = database.prepare(`
      SELECT 1
      FROM learning_events
      WHERE event_type='circuit_unclassified' AND pattern=?
      LIMIT 1
    `).get(signature);
    if (!exists) return false;

    const actor = options.actor?.trim() || 'operator';
    const inserted = recordLearningEvent({
      agentId: actor,
      eventType: 'circuit_pattern_invalidated',
      pattern: signature,
      context: {
        actor,
        reason: options.reason?.trim() || 'manual invalidation',
      },
    }, database);
    if (inserted == null) return false;

    logDecision({
      phase: 'failure-learning',
      decision: 'circuit-pattern:invalidate',
      reason: `${signature} — ${options.reason?.trim() || 'manual invalidation'}`,
      evidenceTier: 'T1',
      actor,
    });
    clearLearningPatternCache();
    return true;
  } catch (error) {
    log.warn({
      pattern: signature,
      error: error instanceof Error ? error.message : String(error),
    }, 'Failed to invalidate learned circuit pattern');
    return false;
  }
}

export function getFailureDigest(
  db?: Database.Database,
): FailureDigest {
  const generatedAt = new Date().toISOString();
  try {
    const database = db ?? getDb();
    const totals = database.prepare(`
      SELECT
        event_type,
        COUNT(*) AS count,
        SUM(CASE WHEN auto_applied=1 THEN 1 ELSE 0 END) AS auto_applied,
        MAX(created_at) AS last_seen
      FROM learning_events
      WHERE created_at >= datetime('now', '-${LEARNING_WINDOW_DAYS} days')
      GROUP BY event_type
      ORDER BY count DESC, event_type ASC
    `).all() as Array<{
      event_type: string;
      count: number;
      auto_applied: number;
      last_seen: string;
    }>;

    return {
      generatedAt,
      windowDays: LEARNING_WINDOW_DAYS,
      totals: totals.map((row) => ({
        eventType: row.event_type,
        count: Number(row.count),
        autoApplied: Number(row.auto_applied),
        lastSeen: row.last_seen,
      })),
      learnedCircuitPatterns: getLearnedCircuitPatterns(database).map((pattern) => ({
        signature: pattern.signature,
        sourceCount: pattern.sourceCount,
        firstSeen: pattern.firstSeen,
        lastSeen: pattern.lastSeen,
        reason: pattern.reason,
        immediateOpen: pattern.immediateOpen,
        failureThreshold: pattern.failureThreshold,
      })),
    };
  } catch (error) {
    log.warn({
      error: error instanceof Error ? error.message : String(error),
    }, 'Failed to build failure digest');
    return {
      generatedAt,
      windowDays: LEARNING_WINDOW_DAYS,
      totals: [],
      learnedCircuitPatterns: [],
    };
  }
}

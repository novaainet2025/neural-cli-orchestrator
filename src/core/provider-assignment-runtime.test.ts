import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../utils/config.js';
import { ProviderAssignmentRuntime } from './provider-assignment-runtime.js';

function config(id: string, capability: string): ProviderConfig {
  return {
    id,
    name: id,
    enabled: true,
    type: 'cli',
    role: 'Engineer',
    score: 80,
    model: null,
    command: id,
    args: [],
    env: {},
    concurrency: 2,
    rateLimitRpm: 20,
    cost: 'paid',
    capabilities: [capability],
    permissions: {},
    persona: { systemPrompt: '', tone: '', style: '' },
    healthCheck: {},
  };
}

describe('ProviderAssignmentRuntime', () => {
  let database: Database.Database;
  let sequence: number;

  beforeEach(() => {
    database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    database.exec(`
      CREATE TABLE organizations (id TEXT PRIMARY KEY);
      CREATE TABLE teams (id TEXT PRIMARY KEY, organization_id TEXT REFERENCES organizations(id));
      CREATE TABLE tasks (id TEXT PRIMARY KEY, assigned_to TEXT, status TEXT);
      CREATE TABLE rate_limit_state (
        agent_id TEXT PRIMARY KEY,
        is_limited INTEGER,
        reset_at TEXT
      );
      INSERT INTO organizations(id) VALUES ('org-1');
      INSERT INTO teams(id, organization_id) VALUES ('team-1', 'org-1');
    `);
    database.exec(readFileSync(
      resolve(process.cwd(), 'db/migrations/112_provider_assignment_policies.sql'),
      'utf8',
    ));
    sequence = 0;
  });

  afterEach(() => database.close());

  function runtime(providers: ProviderConfig[], enabledIds: string[]): ProviderAssignmentRuntime {
    return new ProviderAssignmentRuntime({
      database,
      providers: () => providers,
      enabledProviderIds: () => enabledIds,
      circuitAvailability: () => ({ available: true, circuitState: 'closed' }),
      now: () => new Date('2026-08-01T00:00:00.000Z'),
      createAssignmentId: () => `assignment-${++sequence}`,
    });
  }

  it('resolves the same policy against each PC local enabled registry', () => {
    const providers = [config('codex', 'code'), config('ollama', 'code')];
    const mac = runtime(providers, ['codex']);
    mac.upsertPolicy('team', 'team-1', { requiredCapabilities: ['code'] });
    const macSnapshot = mac.resolveAssignment({
      scopeType: 'team',
      scopeId: 'team-1',
      refresh: true,
      taskRequiredCapabilities: [],
    });

    const otherPc = runtime(providers, ['ollama']);
    const otherSnapshot = otherPc.resolveAssignment({
      scopeType: 'team',
      scopeId: 'team-1',
      refresh: true,
      taskRequiredCapabilities: [],
    });

    expect(macSnapshot.providerIds).toEqual(['codex']);
    expect(otherSnapshot.providerIds).toEqual(['ollama']);
    expect(otherSnapshot.candidates.find((candidate) => candidate.id === 'codex')?.reasons)
      .toContain('not_enabled_by_local_nco');
  });

  it('reuses a valid snapshot but refreshes after capacity changes', () => {
    const service = runtime([config('codex', 'code')], ['codex']);
    service.upsertPolicy('organization', 'org-1', { requiredCapabilities: ['code'] });
    const request = {
      scopeType: 'organization' as const,
      scopeId: 'org-1',
      refresh: false,
      taskRequiredCapabilities: [],
    };
    const first = service.resolveAssignment(request);
    const cached = service.resolveAssignment(request);
    database.prepare(`
      INSERT INTO tasks(id, assigned_to, status) VALUES ('task-1', 'codex', 'running')
    `).run();
    const changed = service.resolveAssignment(request);

    expect(cached.assignmentId).toBe(first.assignmentId);
    expect(changed.assignmentId).not.toBe(first.assignmentId);
    expect(changed.availabilityFingerprint).not.toBe(first.availabilityFingerprint);
  });

  it('fails closed when all matching providers are capacity full', () => {
    const provider = { ...config('codex', 'testing'), concurrency: 1 };
    database.prepare(`
      INSERT INTO tasks(id, assigned_to, status) VALUES ('task-1', 'codex', 'running')
    `).run();
    const service = runtime([provider], ['codex']);
    service.upsertPolicy('team', 'team-1', { requiredCapabilities: ['testing'] });

    const result = service.resolveAssignment({
      scopeType: 'team',
      scopeId: 'team-1',
      refresh: true,
      taskRequiredCapabilities: [],
    });

    expect(result.status).toBe('unassigned');
    expect(result.candidates[0]?.reasons).toContain('capacity_full');
  });
});

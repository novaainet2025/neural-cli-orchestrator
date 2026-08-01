import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveProviderAssignment } from './provider-assignment.js';
import {
  ProviderAssignmentStore,
  ProviderAssignmentStoreError,
} from './provider-assignment-store.js';

describe('ProviderAssignmentStore', () => {
  let database: Database.Database;
  let store: ProviderAssignmentStore;

  beforeEach(() => {
    database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    database.exec(`
      CREATE TABLE organizations (id TEXT PRIMARY KEY);
      CREATE TABLE teams (id TEXT PRIMARY KEY, organization_id TEXT REFERENCES organizations(id));
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
    `);
    database.exec(readFileSync(
      resolve(process.cwd(), 'db/migrations/112_provider_assignment_policies.sql'),
      'utf8',
    ));
    database.exec(readFileSync(
      resolve(process.cwd(), 'db/migrations/124_provider_assignment_registry_revision.sql'),
      'utf8',
    ));
    database.exec(`
      INSERT INTO organizations(id) VALUES ('org-1');
      INSERT INTO teams(id, organization_id) VALUES ('team-1', 'org-1');
      INSERT INTO tasks(id) VALUES ('task-1');
    `);
    store = new ProviderAssignmentStore(database);
  });

  afterEach(() => database.close());

  it('increments policy versions without forcing decomposer capabilities onto teams', () => {
    const first = store.upsertPolicy('organization', 'org-1', {
      requiredCapabilities: ['code'],
      preferredRoles: ['Engineer'],
    });
    const second = store.upsertPolicy('organization', 'org-1', {
      requiredCapabilities: ['code'],
      preferredRoles: ['Reviewer'],
    });
    store.upsertPolicy('team', 'team-1', { requiredCapabilities: ['testing'] });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(store.getEffectivePolicy('organization', 'org-1').requiredCapabilities)
      .toEqual(['code']);
    expect(store.getEffectivePolicy('team', 'team-1', {}, ['browser']).requiredCapabilities)
      .toEqual(['testing', 'browser']);
    expect(store.getEffectivePolicy('team', 'team-1').preferredRoles)
      .toEqual(['Reviewer']);
  });

  it('persists immutable snapshots and failover lineage events', () => {
    const snapshot = resolveProviderAssignment({
      scopeType: 'team',
      scopeId: 'team-1',
      registryRevision: 'registry-1',
      assignmentId: 'assignment-1',
      providers: [{
        id: 'codex',
        enabled: true,
        capabilities: ['code'],
        role: 'Engineer',
        cost: 'paid',
        type: 'cli',
        score: 80,
        availability: {
          healthy: true,
          circuitState: 'closed',
          rateLimited: false,
          capacityUsed: 0,
          capacityTotal: 1,
        },
      }],
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    store.appendSnapshot(snapshot);
    store.appendEvent({
      id: 'event-1',
      assignmentId: snapshot.assignmentId,
      eventType: 'failover',
      taskId: 'task-1',
      fromProviderId: 'codex',
      toProviderId: 'opencode',
      reason: 'rate_limited',
      evidence: { failureClass: 'quota' },
      createdAt: '2026-08-01T00:01:00.000Z',
    });

    expect(store.getLatestSnapshot('team', 'team-1')).toEqual(snapshot);
    expect(store.listEvents(snapshot.assignmentId)).toEqual([expect.objectContaining({
      id: 'event-1',
      taskId: 'task-1',
      fromProviderId: 'codex',
      toProviderId: 'opencode',
      evidence: { failureClass: 'quota' },
    })]);
    expect(() => store.appendSnapshot(snapshot)).toThrow();
  });

  it('fails closed on corrupt persisted JSON', () => {
    database.pragma('ignore_check_constraints = ON');
    database.prepare(`
      INSERT INTO provider_assignment_policies(scope_type, scope_id, policy_json)
      VALUES ('team', 'bad-team', 'not-json')
    `).run();
    database.pragma('ignore_check_constraints = OFF');

    expect(() => store.getPolicy('team', 'bad-team')).toThrow(ProviderAssignmentStoreError);
  });
});

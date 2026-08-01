import type Database from 'better-sqlite3';
import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import {
  mergeProviderAssignmentPolicy,
  type ProviderAssignmentPolicy,
  type ProviderAssignmentPolicyOverride,
  type ProviderAssignmentScope,
  type ProviderAssignmentSnapshot,
} from './provider-assignment.js';

export interface ProviderAssignmentPolicyRecord {
  scopeType: ProviderAssignmentScope;
  scopeId: string;
  policy: ProviderAssignmentPolicyOverride;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderAssignmentEvent {
  id: string;
  assignmentId: string;
  eventType: string;
  taskId: string | null;
  fromProviderId: string | null;
  toProviderId: string | null;
  reason: string;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface AppendProviderAssignmentEventInput {
  id?: string;
  assignmentId: string;
  eventType: string;
  taskId?: string | null;
  fromProviderId?: string | null;
  toProviderId?: string | null;
  reason: string;
  evidence?: Record<string, unknown>;
  createdAt?: string;
}

interface PolicyRow {
  scope_type: ProviderAssignmentScope;
  scope_id: string;
  policy_json: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface SnapshotRow {
  id: string;
  scope_type: ProviderAssignmentScope;
  scope_id: string;
  registry_revision: string;
  status: 'assigned' | 'unassigned';
  primary_provider_id: string | null;
  provider_ids_json: string;
  policy_fingerprint: string;
  provider_config_fingerprint: string;
  availability_fingerprint: string;
  reason: string;
  candidates_json: string;
  created_at: string;
  valid_until: string;
}

interface EventRow {
  id: string;
  assignment_id: string;
  event_type: string;
  task_id: string | null;
  from_provider_id: string | null;
  to_provider_id: string | null;
  reason: string;
  evidence_json: string;
  created_at: string;
}

export class ProviderAssignmentStoreError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ProviderAssignmentStoreError';
  }
}

function parseJson<T>(raw: string, field: string, validate: (value: unknown) => boolean): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!validate(parsed)) throw new Error('unexpected JSON shape');
    return parsed as T;
  } catch (error) {
    throw new ProviderAssignmentStoreError(`invalid ${field} JSON`, error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function policyFromRow(row: PolicyRow): ProviderAssignmentPolicyRecord {
  return {
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    policy: parseJson<ProviderAssignmentPolicyOverride>(row.policy_json, 'policy', isRecord),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function snapshotFromRow(row: SnapshotRow): ProviderAssignmentSnapshot {
  return {
    assignmentId: row.id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    registryRevision: row.registry_revision,
    status: row.status,
    primaryProviderId: row.primary_provider_id,
    providerIds: parseJson<string[]>(row.provider_ids_json, 'provider_ids', (value) => (
      Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    )),
    policyFingerprint: row.policy_fingerprint,
    providerConfigFingerprint: row.provider_config_fingerprint,
    availabilityFingerprint: row.availability_fingerprint,
    reason: row.reason,
    candidates: parseJson<ProviderAssignmentSnapshot['candidates']>(
      row.candidates_json,
      'candidates',
      Array.isArray,
    ),
    createdAt: row.created_at,
    validUntil: row.valid_until,
  };
}

function eventFromRow(row: EventRow): ProviderAssignmentEvent {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    eventType: row.event_type,
    taskId: row.task_id,
    fromProviderId: row.from_provider_id,
    toProviderId: row.to_provider_id,
    reason: row.reason,
    evidence: parseJson<Record<string, unknown>>(row.evidence_json, 'event evidence', isRecord),
    createdAt: row.created_at,
  };
}

export class ProviderAssignmentStore {
  constructor(private readonly database: Database.Database = getDb()) {}

  getPolicy(
    scopeType: ProviderAssignmentScope,
    scopeId: string,
  ): ProviderAssignmentPolicyRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM provider_assignment_policies
      WHERE scope_type=? AND scope_id=?
    `).get(scopeType, scopeId) as PolicyRow | undefined;
    return row ? policyFromRow(row) : null;
  }

  upsertPolicy(
    scopeType: ProviderAssignmentScope,
    scopeId: string,
    policy: ProviderAssignmentPolicyOverride,
  ): ProviderAssignmentPolicyRecord {
    const write = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO provider_assignment_policies (
          scope_type, scope_id, policy_json, version, created_at, updated_at
        ) VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
        ON CONFLICT(scope_type, scope_id) DO UPDATE SET
          policy_json=excluded.policy_json,
          version=provider_assignment_policies.version + 1,
          updated_at=datetime('now')
      `).run(scopeType, scopeId, JSON.stringify(policy));
      const record = this.getPolicy(scopeType, scopeId);
      if (!record) throw new ProviderAssignmentStoreError('policy write did not produce a row');
      return record;
    });
    return write.immediate();
  }

  getEffectivePolicy(
    scopeType: ProviderAssignmentScope,
    scopeId: string,
    systemPolicy: ProviderAssignmentPolicyOverride = {},
    taskRequiredCapabilities: readonly string[] = [],
  ): ProviderAssignmentPolicy {
    if (scopeType === 'organization') {
      return mergeProviderAssignmentPolicy(
        systemPolicy,
        this.getPolicy('organization', scopeId)?.policy ?? null,
        null,
        taskRequiredCapabilities,
      );
    }
    const team = this.database.prepare('SELECT organization_id FROM teams WHERE id=?')
      .get(scopeId) as { organization_id: string | null } | undefined;
    const organizationPolicy = team?.organization_id
      ? this.getPolicy('organization', team.organization_id)?.policy ?? null
      : null;
    // Organization requiredCapabilities select the company decomposer. Carrying
    // them into every team would require one provider to satisfy unrelated gates
    // such as architecture + testing. All other organization fields remain team
    // defaults for backward compatibility; teams and tasks keep their own hard
    // capability requirements.
    const companyPolicy = organizationPolicy
      ? Object.fromEntries(
        Object.entries(organizationPolicy)
          .filter(([key]) => key !== 'requiredCapabilities'),
      ) as ProviderAssignmentPolicyOverride
      : null;
    return mergeProviderAssignmentPolicy(
      systemPolicy,
      companyPolicy,
      this.getPolicy('team', scopeId)?.policy ?? null,
      taskRequiredCapabilities,
    );
  }

  appendSnapshot(snapshot: ProviderAssignmentSnapshot): ProviderAssignmentSnapshot {
    this.database.prepare(`
      INSERT INTO provider_assignment_snapshots (
        id, scope_type, scope_id, registry_revision, status, primary_provider_id, provider_ids_json,
        policy_fingerprint, provider_config_fingerprint, availability_fingerprint,
        reason, candidates_json, created_at, valid_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.assignmentId,
      snapshot.scopeType,
      snapshot.scopeId,
      snapshot.registryRevision,
      snapshot.status,
      snapshot.primaryProviderId,
      JSON.stringify(snapshot.providerIds),
      snapshot.policyFingerprint,
      snapshot.providerConfigFingerprint,
      snapshot.availabilityFingerprint,
      snapshot.reason,
      JSON.stringify(snapshot.candidates),
      snapshot.createdAt,
      snapshot.validUntil,
    );
    return snapshot;
  }

  getSnapshot(assignmentId: string): ProviderAssignmentSnapshot | null {
    const row = this.database.prepare('SELECT * FROM provider_assignment_snapshots WHERE id=?')
      .get(assignmentId) as SnapshotRow | undefined;
    return row ? snapshotFromRow(row) : null;
  }

  getLatestSnapshot(
    scopeType: ProviderAssignmentScope,
    scopeId: string,
  ): ProviderAssignmentSnapshot | null {
    const row = this.database.prepare(`
      SELECT * FROM provider_assignment_snapshots
      WHERE scope_type=? AND scope_id=?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(scopeType, scopeId) as SnapshotRow | undefined;
    return row ? snapshotFromRow(row) : null;
  }

  appendEvent(input: AppendProviderAssignmentEventInput): ProviderAssignmentEvent {
    const event: ProviderAssignmentEvent = {
      id: input.id ?? createId('paevt'),
      assignmentId: input.assignmentId,
      eventType: input.eventType,
      taskId: input.taskId ?? null,
      fromProviderId: input.fromProviderId ?? null,
      toProviderId: input.toProviderId ?? null,
      reason: input.reason,
      evidence: input.evidence ?? {},
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.database.prepare(`
      INSERT INTO provider_assignment_events (
        id, assignment_id, event_type, task_id, from_provider_id, to_provider_id,
        reason, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.assignmentId,
      event.eventType,
      event.taskId,
      event.fromProviderId,
      event.toProviderId,
      event.reason,
      JSON.stringify(event.evidence),
      event.createdAt,
    );
    return event;
  }

  listEvents(assignmentId: string): ProviderAssignmentEvent[] {
    return (this.database.prepare(`
      SELECT * FROM provider_assignment_events
      WHERE assignment_id=?
      ORDER BY created_at ASC, rowid ASC
    `).all(assignmentId) as EventRow[]).map(eventFromRow);
  }
}

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { getDb } from '../storage/database.js';
import { dynamicSkillEngine, type DynamicSkill } from './dynamic-skill-engine.js';
import type { AcquisitionCandidate, AcquisitionVettingResult } from '../security/acquisition-vetting.js';

export interface AcquisitionRecord {
  id: string;
  package_name: string;
  version: string;
  source_type: string;
  source_ref: string | null;
  discovered_from_json: string;
  vet_results_json: string;
  decision: string;
  decision_reason: string;
  approval_state: string;
  installed_path: string | null;
  package_sha256: string | null;
  manifest_sha256: string | null;
  installed_at: string | null;
  created_at: string;
}

class AcquisitionRegistry {
  createDiscovery(candidate: AcquisitionCandidate, discoveredFrom: Record<string, unknown>): AcquisitionRecord {
    const existing = this.getByPackageVersion(candidate.packageName, candidate.version);
    if (existing) {
      return existing;
    }

    const db = getDb();
    const id = `acq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`
      INSERT INTO acquisitions (
        id, package_name, version, source_type, source_ref,
        discovered_from_json, vet_results_json, decision, decision_reason, approval_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      candidate.packageName,
      candidate.version,
      candidate.sourceType ?? 'manual',
      candidate.sourceRef ?? null,
      JSON.stringify(discoveredFrom),
      JSON.stringify({}),
      'discovered',
      'candidate recorded',
      'none',
    );
    return this.getById(id)!;
  }

  saveVetting(recordId: string, vetting: AcquisitionVettingResult): AcquisitionRecord {
    const db = getDb();
    const decision = vetting.decision === 'hard_reject'
      ? 'rejected'
      : vetting.decision === 'approval_required'
        ? 'approval_required'
        : 'vet_passed';
    db.prepare(`
      UPDATE acquisitions
      SET vet_results_json = ?, decision = ?, decision_reason = ?, approval_state = ?
      WHERE id = ?
    `).run(
      JSON.stringify(vetting.gateResults),
      decision,
      vetting.reasons.join('; '),
      vetting.decision === 'approval_required' ? 'required' : 'none',
      recordId,
    );
    return this.getById(recordId)!;
  }

  markInstalled(recordId: string, installedPath: string, packageSha256: string): AcquisitionRecord {
    const db = getDb();
    db.prepare(`
      UPDATE acquisitions
      SET decision = 'installed',
          decision_reason = ?,
          installed_path = ?,
          package_sha256 = ?,
          installed_at = datetime('now')
      WHERE id = ?
    `).run('package installed', installedPath, packageSha256, recordId);
    return this.getById(recordId)!;
  }

  markInstallFailed(recordId: string, reason: string): AcquisitionRecord {
    const db = getDb();
    db.prepare(`
      UPDATE acquisitions
      SET decision = 'install_failed',
          decision_reason = ?
      WHERE id = ?
    `).run(reason, recordId);
    return this.getById(recordId)!;
  }

  markRegistrationFailed(recordId: string, reason: string): AcquisitionRecord {
    const db = getDb();
    db.prepare(`
      UPDATE acquisitions
      SET decision = 'registration_failed',
          decision_reason = ?
      WHERE id = ?
    `).run(reason, recordId);
    return this.getById(recordId)!;
  }

  async registerDynamicSkill(recordId: string): Promise<{ record: AcquisitionRecord; skill: DynamicSkill }> {
    const record = this.getById(recordId);
    if (!record?.installed_path) {
      throw new Error(`installed_path missing for ${recordId}`);
    }

    const manifestPath = join(record.installed_path, 'package.json');
    const manifestRaw = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestRaw) as {
      name?: string;
      version?: string;
      description?: string;
      bin?: string | Record<string, string>;
    };

    const toolName = toAcquiredSkillName(record.package_name);
    const binNames = manifest.bin
      ? typeof manifest.bin === 'string'
        ? [record.package_name]
        : Object.keys(manifest.bin)
      : [];

    const skill = await dynamicSkillEngine.generateSkill({
      name: toolName,
      description: manifest.description || `Acquired package ${record.package_name}@${record.version}`,
      triggerKeywords: [record.package_name, ...binNames],
      customPipeline: [{
        step: 1,
        agentId: 'codex',
        promptTemplate: [
          `Use the acquired package ${record.package_name}@${record.version}.`,
          `Installed path: ${record.installed_path}`,
          binNames.length > 0 ? `Available bin entries: ${binNames.join(', ')}` : 'No bin entries declared.',
          'User request:',
          '{{prompt}}',
        ].join('\n'),
        qualityThreshold: 60,
      }],
    });

    const manifestSha256 = createHash('sha256').update(manifestRaw).digest('hex');
    const discoveredFrom = JSON.parse(record.discovered_from_json || '{}') as Record<string, unknown>;
    discoveredFrom.registeredSkill = skill.name;

    const db = getDb();
    db.prepare(`
      UPDATE acquisitions
      SET decision = 'active',
          decision_reason = ?,
          manifest_sha256 = ?,
          discovered_from_json = ?,
          approval_state = CASE WHEN approval_state = 'required' THEN 'approved' ELSE approval_state END
      WHERE id = ?
    `).run(
      `dynamic skill registered: ${skill.name}`,
      manifestSha256,
      JSON.stringify(discoveredFrom),
      recordId,
    );

    return { record: this.getById(recordId)!, skill };
  }

  list(limit = 100): AcquisitionRecord[] {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM acquisitions
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as AcquisitionRecord[];
  }

  getById(id: string): AcquisitionRecord | undefined {
    const db = getDb();
    return db.prepare(`SELECT * FROM acquisitions WHERE id = ?`).get(id) as AcquisitionRecord | undefined;
  }

  getByPackageVersion(packageName: string, version: string): AcquisitionRecord | undefined {
    const db = getDb();
    return db.prepare(`
      SELECT *
      FROM acquisitions
      WHERE package_name = ? AND version = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(packageName, version) as AcquisitionRecord | undefined;
  }

  listTrustedPackageNames(): string[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT DISTINCT package_name
      FROM acquisitions
      WHERE decision IN ('installed', 'active')
    `).all() as Array<{ package_name: string }>;
    return rows.map(row => row.package_name);
  }

  getLatestMaintainers(packageName: string): string[] | null {
    const db = getDb();
    const row = db.prepare(`
      SELECT vet_results_json
      FROM acquisitions
      WHERE package_name = ?
        AND decision IN ('installed', 'active')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(packageName) as { vet_results_json?: string } | undefined;
    if (!row?.vet_results_json) return null;
    try {
      const vetResults = JSON.parse(row.vet_results_json) as Record<string, { evidence?: any }>;
      const maintainers = vetResults.maintainer?.evidence?.maintainers;
      return Array.isArray(maintainers) ? maintainers.filter((value: unknown): value is string => typeof value === 'string') : null;
    } catch {
      return null;
    }
  }

  listAcquiredSkillNames(): Array<{ id: string; name: string; description: string }> {
    const db = getDb();
    return db.prepare(`
      SELECT id, name, description
      FROM dynamic_skills
      WHERE is_active = 1
        AND name LIKE 'acquired_%'
      ORDER BY usage_count DESC, created_at DESC
    `).all() as Array<{ id: string; name: string; description: string }>;
  }
}

export const acquisitionRegistry = new AcquisitionRegistry();

export function toAcquiredSkillName(packageName: string): string {
  return `acquired_${packageName.replace(/[^a-zA-Z0-9]+/g, '_')}`;
}

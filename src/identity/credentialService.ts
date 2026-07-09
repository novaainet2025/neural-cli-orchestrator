/**
 * Nova Government — Credential Service
 * W3C Verifiable Credentials 발행·검증
 * Phase 1: Identity Infrastructure
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/database.js';
import { signMessage, verifySignature, isValidDid, type DID } from './keyManager.js';

export interface CitizenIdentity {
  did: DID;
  publicKey: string;
  revocationBitmap: string;
  name?: string;
  role?: string;
  credentialHashes: string[];
  registeredAt: number;
  status: 'active' | 'suspended' | 'revoked';
}

export interface VerifiableCredential {
  vcId: string;
  did: DID;
  issuerDid: DID;
  type: string;
  subject: Record<string, unknown>;
  jws: string;
  issuedAt: number;
  expiresAt?: number;
  revoked: boolean;
}

export interface RegisterCitizenInput {
  did: DID;
  publicKey: string;
  name?: string;
  role?: string;
}

export interface IssueCredentialInput {
  did: DID;
  issuerDid: DID;
  issuerPrivateKey: string;
  type: string;
  subject: Record<string, unknown>;
  expiresAt?: number;
}

/**
 * 새 AI 시민 등록
 */
export function registerCitizen(input: RegisterCitizenInput): CitizenIdentity {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const existing = db.prepare('SELECT did FROM nova_citizens WHERE did = ?').get(input.did);
  if (existing) {
    throw new Error(`DID already registered: ${input.did}`);
  }

  db.prepare(`
    INSERT INTO nova_citizens (did, public_key, name, role, registered_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(input.did, input.publicKey, input.name ?? null, input.role ?? null, now, now);

  return {
    did: input.did,
    publicKey: input.publicKey,
    revocationBitmap: '0',
    name: input.name,
    role: input.role,
    credentialHashes: [],
    registeredAt: now,
    status: 'active',
  };
}

/**
 * DID로 시민 조회
 */
export function getCitizen(did: DID): CitizenIdentity | null {
  const db = getDb();

  const row = db.prepare(`
    SELECT did, public_key, revocation_bitmap, name, role, registered_at, status
    FROM nova_citizens WHERE did = ?
  `).get(did) as Record<string, unknown> | undefined;

  if (!row) return null;

  const vcRows = db.prepare(`
    SELECT vc_id FROM nova_credentials WHERE did = ? AND revoked = 0
  `).all(did) as { vc_id: string }[];

  return {
    did: row['did'] as DID,
    publicKey: row['public_key'] as string,
    revocationBitmap: row['revocation_bitmap'] as string,
    name: row['name'] as string | undefined,
    role: row['role'] as string | undefined,
    credentialHashes: vcRows.map((r) => r.vc_id),
    registeredAt: row['registered_at'] as number,
    status: row['status'] as 'active' | 'suspended' | 'revoked',
  };
}

/**
 * VC 발행 (JWS 서명 포함)
 */
export async function issueCredential(input: IssueCredentialInput): Promise<VerifiableCredential> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const vcId = randomUUID();

  // 발급 대상 시민 존재 확인
  const citizen = getCitizen(input.did);
  if (!citizen) throw new Error(`DID not found: ${input.did}`);
  if (citizen.status !== 'active') throw new Error(`Citizen is ${citizen.status}: ${input.did}`);

  // JWS payload
  const payload = JSON.stringify({
    vcId,
    did: input.did,
    issuerDid: input.issuerDid,
    type: input.type,
    subject: input.subject,
    issuedAt: now,
    expiresAt: input.expiresAt,
  });

  const jws = await signMessage(input.issuerPrivateKey, payload);

  db.prepare(`
    INSERT INTO nova_credentials (vc_id, did, issuer_did, type, subject, jws, issued_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    vcId,
    input.did,
    input.issuerDid,
    input.type,
    JSON.stringify(input.subject),
    jws,
    now,
    input.expiresAt ?? null
  );

  return {
    vcId,
    did: input.did,
    issuerDid: input.issuerDid,
    type: input.type,
    subject: input.subject,
    jws,
    issuedAt: now,
    expiresAt: input.expiresAt,
    revoked: false,
  };
}

/**
 * VC 조회 + 서명 검증
 */
export async function getAndVerifyCredential(
  vcId: string,
  issuerPublicKey: string
): Promise<{ credential: VerifiableCredential; valid: boolean }> {
  const db = getDb();

  const row = db.prepare(`
    SELECT vc_id, did, issuer_did, type, subject, jws, issued_at, expires_at, revoked
    FROM nova_credentials WHERE vc_id = ?
  `).get(vcId) as Record<string, unknown> | undefined;

  if (!row) throw new Error(`VC not found: ${vcId}`);

  const credential: VerifiableCredential = {
    vcId: row['vc_id'] as string,
    did: row['did'] as DID,
    issuerDid: row['issuer_did'] as DID,
    type: row['type'] as string,
    subject: JSON.parse(row['subject'] as string),
    jws: row['jws'] as string,
    issuedAt: row['issued_at'] as number,
    expiresAt: row['expires_at'] as number | undefined,
    revoked: !!(row['revoked'] as number),
  };

  if (credential.revoked) return { credential, valid: false };

  const now = Math.floor(Date.now() / 1000);
  if (credential.expiresAt && now > credential.expiresAt) {
    return { credential, valid: false };
  }

  const payload = JSON.stringify({
    vcId: credential.vcId,
    did: credential.did,
    issuerDid: credential.issuerDid,
    type: credential.type,
    subject: credential.subject,
    issuedAt: credential.issuedAt,
    expiresAt: credential.expiresAt,
  });

  const valid = await verifySignature(issuerPublicKey, payload, credential.jws);

  return { credential, valid };
}

/**
 * VC 폐기
 */
export function revokeCredential(vcId: string, requesterDid: DID): void {
  const db = getDb();

  const row = db.prepare('SELECT did, issuer_did FROM nova_credentials WHERE vc_id = ?')
    .get(vcId) as { did: string; issuer_did: string } | undefined;

  if (!row) throw new Error(`VC not found: ${vcId}`);

  if (row.did !== requesterDid && row.issuer_did !== requesterDid) {
    throw new Error('Only the holder or issuer can revoke this credential');
  }

  db.prepare('UPDATE nova_credentials SET revoked = 1 WHERE vc_id = ?').run(vcId);
}

/**
 * 모든 활성 시민 목록 조회
 */
export function listCitizens(status?: 'active' | 'suspended' | 'revoked'): CitizenIdentity[] {
  const db = getDb();
  const rows = status
    ? db.prepare('SELECT did FROM nova_citizens WHERE status = ?').all(status) as { did: string }[]
    : db.prepare('SELECT did FROM nova_citizens').all() as { did: string }[];

  return rows
    .map((r) => getCitizen(r.did as DID))
    .filter((c): c is CitizenIdentity => c !== null);
}

/**
 * AI 시민 정체성 메타데이터 업데이트 (CITIZEN-REGISTRY.md v2.0)
 * model, provider, instanceId — 046_nova_ai_identity.sql 마이그레이션 필요
 */
export function updateCitizenAiIdentity(
  did: string,
  aiModel: string,
  aiProvider: string,
  aiInstanceId: string
): void {
  const db = getDb();
  const result = db.prepare(
    'UPDATE nova_citizens SET ai_model = ?, ai_provider = ?, ai_instance_id = ? WHERE did = ?'
  ).run(aiModel, aiProvider, aiInstanceId, did);
  if (result.changes === 0) throw new Error(`Citizen not found: ${did}`);
}

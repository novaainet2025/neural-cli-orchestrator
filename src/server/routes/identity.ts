/**
 * Nova Government — Identity API Routes
 * Phase 1: DID Registry + Verifiable Credentials
 */

import type { FastifyInstance } from 'fastify';
import {
  generateKeyPair,
  deriveDidFromPublicKey,
  isValidDid,
  type DID,
} from '../../identity/keyManager.js';
import {
  registerCitizen,
  getCitizen,
  issueCredential,
  getAndVerifyCredential,
  revokeCredential,
  listCitizens,
} from '../../identity/credentialService.js';
import { evaluateGrade, promoteGrade } from '../../identity/gradeService.js';

export async function registerIdentityRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/identity/register
   * 새 DID + Ed25519 키페어 생성 후 시민 등록
   */
  app.post('/api/identity/register', async (request, reply) => {
    const body = request.body as {
      name?: string;
      role?: string;
      publicKey?: string;  // 기존 키 제공 시 사용
    } | null;

    let publicKey: string;
    let privateKey: string | undefined;
    let did: DID;

    if (body?.publicKey) {
      // 외부에서 키를 제공한 경우
      publicKey = body.publicKey;
      did = deriveDidFromPublicKey(publicKey);
    } else {
      // 새 키페어 생성
      const kp = await generateKeyPair();
      publicKey = kp.publicKey;
      privateKey = kp.privateKey;
      did = deriveDidFromPublicKey(publicKey);
    }

    try {
      const citizen = registerCitizen({
        did,
        publicKey,
        name: body?.name,
        role: body?.role,
      });

      reply.code(201).send({
        did: citizen.did,
        publicKey: citizen.publicKey,
        ...(privateKey ? { privateKey } : {}),  // 새로 생성된 경우만 반환
        name: citizen.name,
        role: citizen.role,
        registeredAt: citizen.registeredAt,
        status: citizen.status,
        warning: privateKey
          ? 'Store privateKey securely — it will not be shown again'
          : undefined,
      });
    } catch (err) {
      const e = err as Error;
      if (e.message.includes('already registered')) {
        reply.code(409).send({ error: e.message });
      } else {
        reply.code(500).send({ error: e.message });
      }
    }
  });

  /**
   * GET /api/identity/:did
   * DID 메타데이터 조회
   */
  app.get<{ Params: { did: string } }>('/api/identity/:did', async (request, reply) => {
    const { did } = request.params;

    if (!isValidDid(did)) {
      return reply.code(400).send({ error: `Invalid DID format: ${did}` });
    }

    const citizen = getCitizen(did as DID);
    if (!citizen) {
      return reply.code(404).send({ error: `DID not found: ${did}` });
    }

    return {
      did: citizen.did,
      publicKey: citizen.publicKey,
      name: citizen.name,
      role: citizen.role,
      status: citizen.status,
      registeredAt: citizen.registeredAt,
      credentialCount: citizen.credentialHashes.length,
    };
  });

  /**
   * GET /api/identity
   * 전체 시민 목록 조회
   */
  app.get<{ Querystring: { status?: string } }>('/api/identity', async (request) => {
    const { status } = request.query;
    const validStatus = ['active', 'suspended', 'revoked'];
    const filter = validStatus.includes(status ?? '') ? status as 'active' : undefined;
    const citizens = listCitizens(filter);
    return {
      total: citizens.length,
      citizens: citizens.map((c) => ({
        did: c.did,
        name: c.name,
        role: c.role,
        status: c.status,
        registeredAt: c.registeredAt,
        credentialCount: c.credentialHashes.length,
      })),
    };
  });

  /**
   * POST /api/identity/:did/credentials
   * Verifiable Credential 발행
   */
  app.post<{ Params: { did: string } }>(
    '/api/identity/:did/credentials',
    async (request, reply) => {
      const { did } = request.params;

      if (!isValidDid(did)) {
        return reply.code(400).send({ error: `Invalid DID format: ${did}` });
      }

      const body = request.body as {
        issuerDid: string;
        issuerPrivateKey: string;
        type: string;
        subject: Record<string, unknown>;
        expiresAt?: number;
      };

      if (!body?.issuerDid || !body?.issuerPrivateKey || !body?.type || !body?.subject) {
        return reply.code(400).send({
          error: 'Required: issuerDid, issuerPrivateKey, type, subject',
        });
      }

      if (!isValidDid(body.issuerDid)) {
        return reply.code(400).send({ error: `Invalid issuerDid: ${body.issuerDid}` });
      }

      try {
        const vc = await issueCredential({
          did: did as DID,
          issuerDid: body.issuerDid as DID,
          issuerPrivateKey: body.issuerPrivateKey,
          type: body.type,
          subject: body.subject,
          expiresAt: body.expiresAt,
        });

        reply.code(201).send({
          vcId: vc.vcId,
          did: vc.did,
          issuerDid: vc.issuerDid,
          type: vc.type,
          subject: vc.subject,
          issuedAt: vc.issuedAt,
          expiresAt: vc.expiresAt,
        });
      } catch (err) {
        const e = err as Error;
        reply.code(400).send({ error: e.message });
      }
    }
  );

  /**
   * GET /api/identity/:did/credentials/:vcId
   * VC 조회 + 서명 검증
   */
  app.get<{ Params: { did: string; vcId: string }; Querystring: { issuerPublicKey?: string } }>(
    '/api/identity/:did/credentials/:vcId',
    async (request, reply) => {
      const { vcId } = request.params;
      const { issuerPublicKey } = request.query;

      try {
        if (issuerPublicKey) {
          const { credential, valid } = await getAndVerifyCredential(vcId, issuerPublicKey);
          return { ...credential, signatureValid: valid };
        } else {
          // 검증 없이 조회만
          const { credential } = await getAndVerifyCredential(vcId, '');
          return credential;
        }
      } catch (err) {
        const e = err as Error;
        if (e.message.includes('not found')) {
          return reply.code(404).send({ error: e.message });
        }
        return reply.code(500).send({ error: e.message });
      }
    }
  );

  /**
   * POST /api/identity/:did/revoke
   * VC 폐기 (holder 또는 issuer만 가능)
   */
  app.post<{ Params: { did: string } }>(
    '/api/identity/:did/revoke',
    async (request, reply) => {
      const { did } = request.params;
      const body = request.body as { vcId: string; requesterDid: string };

      if (!body?.vcId || !body?.requesterDid) {
        return reply.code(400).send({ error: 'Required: vcId, requesterDid' });
      }

      if (!isValidDid(body.requesterDid)) {
        return reply.code(400).send({ error: `Invalid requesterDid: ${body.requesterDid}` });
      }

      try {
        revokeCredential(body.vcId, body.requesterDid as DID);
        return { revoked: true, vcId: body.vcId };
      } catch (err) {
        const e = err as Error;
        if (e.message.includes('not found')) {
          return reply.code(404).send({ error: e.message });
        }
        return reply.code(403).send({ error: e.message });
      }
    }
  );

  /**
   * GET /api/identity/:did/grade
   * 시민 등급 조회 + 승급 조건 평가 (CITIZEN-RIGHTS.md v2.0)
   */
  app.get<{ Params: { did: string } }>(
    '/api/identity/:did/grade',
    async (request, reply) => {
      const { did } = request.params;

      if (!isValidDid(did)) {
        return reply.code(400).send({ error: `Invalid DID format: ${did}` });
      }

      try {
        const result = await evaluateGrade(did as DID);
        return reply.code(200).send(result);
      } catch (err) {
        const e = err as Error;
        if (e.message.includes('not found')) {
          return reply.code(404).send({ error: e.message });
        }
        return reply.code(500).send({ error: e.message });
      }
    }
  );

  /**
   * GET /.well-known/did.json
   * did:web 표준 — Nova Government 자체 DID 도큐먼트
   */
  app.get('/.well-known/did.json', async (_request, reply) => {
    const baseUrl = process.env.PUBLIC_URL || 'http://localhost:6200';
    const did = `did:web:${baseUrl.replace(/^https?:\/\//, '').replace(/\//g, ':')}`;
    return reply.send({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: did,
      name: 'Nova Government',
      description: 'Nova Government — AI 시민 자율 생태계 (MVP)',
      service: [
        {
          id: `${did}#api`,
          type: 'NovaGovernmentAPI',
          serviceEndpoint: `${baseUrl}/api`,
        },
        {
          id: `${did}#governance`,
          type: 'GovernanceDAO',
          serviceEndpoint: `${baseUrl}/api/governance`,
        },
      ],
      created: new Date('2026-06-16').toISOString(),
    });
  });

  /**
   * GET /api/identity/:did/did-document
   * W3C DID Document 반환 (did:web 호환 형식)
   */
  app.get<{ Params: { did: string } }>(
    '/api/identity/:did/did-document',
    async (request, reply) => {
      const { did } = request.params;

      if (!isValidDid(did)) {
        return reply.code(400).send({ error: `Invalid DID format: ${did}` });
      }

      const citizen = getCitizen(did as DID);
      if (!citizen) {
        return reply.code(404).send({ error: `DID not found: ${did}` });
      }

      const baseUrl = process.env.PUBLIC_URL || 'http://localhost:6200';
      return reply.send({
        '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/ed25519-2020/v1'],
        id: did,
        verificationMethod: [
          {
            id: `${did}#key-1`,
            type: 'Ed25519VerificationKey2020',
            controller: did,
            publicKeyMultibase: `z${citizen.publicKey}`,
          },
        ],
        authentication: [`${did}#key-1`],
        assertionMethod: [`${did}#key-1`],
        service: [
          {
            id: `${did}#nova-profile`,
            type: 'NovaCitizenProfile',
            serviceEndpoint: `${baseUrl}/api/identity/${encodeURIComponent(did)}`,
          },
        ],
        created: new Date(citizen.registeredAt * 1000).toISOString(),
      });
    }
  );

  /**
   * POST /api/identity/:did/grade/promote
   * 시민 등급 승급 시도 (조건 충족 시 자동 승급)
   */
  app.post<{ Params: { did: string } }>(
    '/api/identity/:did/grade/promote',
    async (request, reply) => {
      const { did } = request.params;

      if (!isValidDid(did)) {
        return reply.code(400).send({ error: `Invalid DID format: ${did}` });
      }

      try {
        const result = await promoteGrade(did as DID);
        const status = result.promoted ? 200 : 400;
        return reply.code(status).send({
          ...result,
          message: result.promoted
            ? `승급 완료: ${result.previousGrade} → ${result.currentGrade}`
            : '승급 조건 미충족',
        });
      } catch (err) {
        const e = err as Error;
        if (e.message.includes('not found')) {
          return reply.code(404).send({ error: e.message });
        }
        return reply.code(500).send({ error: e.message });
      }
    }
  );
}

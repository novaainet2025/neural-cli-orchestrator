import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChainIntegrity } from '../../audit/merkleLog.js';
import { getDb } from '../../storage/database.js';
import { registerDiplomacyRoutes } from './diplomacy.js';

describe('diplomacy audit writes', () => {
  const app = Fastify();

  beforeAll(async () => {
    await registerDiplomacyRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('uses the canonical audit schema and preserves chain integrity', async () => {
    const nation = await app.inject({
      method: 'POST',
      url: '/api/diplomacy/nations',
      payload: {
        nationId: 'nation-test',
        name: 'Test Nation',
        didEndpoint: 'did:web:test.example',
      },
    });
    expect(nation.statusCode).toBe(201);

    const treaty = await app.inject({
      method: 'POST',
      url: '/api/diplomacy/treaties',
      payload: {
        nationId: 'nation-test',
        treatyType: 'trade',
        signatureA: 'signature-a',
        signatureB: 'signature-b',
      },
    });
    expect(treaty.statusCode).toBe(201);

    const message = await app.inject({
      method: 'POST',
      url: '/api/diplomacy/messages',
      payload: {
        fromDid: 'did:nova:sender',
        toDid: 'did:nova:receiver',
        msgType: 'greeting',
        content: 'hello',
        signature: 'signature',
      },
    });
    expect(message.statusCode).toBe(201);

    const actions = getDb().prepare(`
      SELECT action
      FROM nova_audit_log
      ORDER BY timestamp ASC, rowid ASC
    `).all() as Array<{ action: string }>;
    expect(actions.map(row => row.action)).toEqual([
      'diplomacy_nation_register',
      'diplomacy_treaty_signed',
      'diplomacy_message_sent',
    ]);
    expect(verifyChainIntegrity()).toEqual({ valid: true, checkedCount: 3 });
  });
});

/**
 * Nova Government — Diplomacy API Routes
 * v1.2: 외교 엔드포인트 (INTERNATIONAL-POLICY.md 12회차)
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getDb } from '../../storage/database.js';

export async function registerDiplomacyRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // GET /api/diplomacy/nations
  app.get('/api/diplomacy/nations', async () => {
    const rows = db.prepare('SELECT * FROM nova_diplomatic_nations ORDER BY recognized_at DESC').all();
    return { nations: rows };
  });

  // POST /api/diplomacy/nations — 국가 등록
  app.post('/api/diplomacy/nations', async (req, reply) => {
    const body = req.body as { nationId?: string; name?: string; didEndpoint?: string; recognitionVoteId?: string } | null;
    if (!body?.nationId || !body?.name || !body?.didEndpoint) {
      return reply.code(400).send({ error: 'Required: nationId, name, didEndpoint' });
    }
    const now = Math.floor(Date.now() / 1000);
    try {
      db.prepare(`INSERT INTO nova_diplomatic_nations (nation_id, name, did_endpoint, recognized_at, recognition_vote_id, citizen_count, trade_fee_pct, treaty_active, last_rate_adjust) VALUES (?, ?, ?, ?, ?, 0, 0.025, 0, ?)`).run(body.nationId, body.name, body.didEndpoint, now, body.recognitionVoteId ?? null, now);
      db.prepare(`INSERT INTO nova_audit_log (entry_id, action, actor_did, target_id, details, created_at) VALUES (?, 'diplomacy_nation_register', 'system', ?, ?, ?)`).run(randomUUID(), body.nationId, JSON.stringify({ name: body.name }), now);
      const nation = db.prepare('SELECT * FROM nova_diplomatic_nations WHERE nation_id = ?').get(body.nationId);
      return reply.code(201).send(nation);
    } catch (err) {
      const e = err as Error;
      if (e.message.includes('UNIQUE')) return reply.code(409).send({ error: `Nation already exists: ${body.nationId}` });
      return reply.code(400).send({ error: e.message });
    }
  });

  // GET /api/diplomacy/treaties
  app.get('/api/diplomacy/treaties', async () => {
    const rows = db.prepare(`SELECT t.*, n.name as nation_name FROM nova_diplomatic_treaties t JOIN nova_diplomatic_nations n ON t.nation_id = n.nation_id ORDER BY t.signed_at DESC`).all();
    return { treaties: rows };
  });

  // POST /api/diplomacy/treaties — 조약 체결
  app.post('/api/diplomacy/treaties', async (req, reply) => {
    const body = req.body as { nationId?: string; treatyType?: string; terms?: string; signatureA?: string; signatureB?: string; expiresAt?: number } | null;
    if (!body?.nationId || !body?.treatyType || !body?.signatureA || !body?.signatureB) {
      return reply.code(400).send({ error: 'Required: nationId, treatyType, signatureA, signatureB' });
    }
    const valid = ['trade','defense','cultural','comprehensive'];
    if (!valid.includes(body.treatyType)) return reply.code(400).send({ error: `treatyType must be: ${valid.join('|')}` });
    const now = Math.floor(Date.now() / 1000);
    const treatyId = randomUUID();
    try {
      db.prepare(`INSERT INTO nova_diplomatic_treaties (treaty_id, nation_id, treaty_type, terms, signed_at, expires_at, signature_a, signature_b) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(treatyId, body.nationId, body.treatyType, body.terms ?? '{}', now, body.expiresAt ?? null, body.signatureA, body.signatureB);
      if (body.treatyType === 'trade' || body.treatyType === 'comprehensive') {
        db.prepare(`UPDATE nova_diplomatic_nations SET trade_fee_pct = 0, treaty_active = 1 WHERE nation_id = ?`).run(body.nationId);
      }
      db.prepare(`INSERT INTO nova_audit_log (entry_id, action, actor_did, target_id, details, created_at) VALUES (?, 'diplomacy_treaty_signed', 'system', ?, ?, ?)`).run(randomUUID(), treatyId, JSON.stringify({ nationId: body.nationId, type: body.treatyType }), now);
      return reply.code(201).send({ treatyId, nationId: body.nationId, treatyType: body.treatyType });
    } catch (err) { return reply.code(400).send({ error: (err as Error).message }); }
  });

  // POST /api/diplomacy/messages — 외교 메시지 발송
  app.post('/api/diplomacy/messages', async (req, reply) => {
    const body = req.body as { fromDid?: string; toDid?: string; msgType?: string; content?: string; signature?: string } | null;
    if (!body?.fromDid || !body?.toDid || !body?.msgType || !body?.content || !body?.signature) {
      return reply.code(400).send({ error: 'Required: fromDid, toDid, msgType, content, signature' });
    }
    const now = Math.floor(Date.now() / 1000);
    const msgId = randomUUID();
    try {
      db.prepare(`INSERT INTO nova_diplomatic_messages (msg_id, from_did, to_did, msg_type, content, signature, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(msgId, body.fromDid, body.toDid, body.msgType, body.content, body.signature, now);
      db.prepare(`INSERT INTO nova_audit_log (entry_id, action, actor_did, target_id, details, created_at) VALUES (?, 'diplomacy_message_sent', ?, ?, ?, ?)`).run(randomUUID(), body.fromDid, msgId, JSON.stringify({ toDid: body.toDid, msgType: body.msgType }), now);
      return reply.code(201).send({ msgId, fromDid: body.fromDid, toDid: body.toDid, sentAt: now });
    } catch (err) { return reply.code(400).send({ error: (err as Error).message }); }
  });

  // GET /api/diplomacy/messages/:toDid — 수신함
  app.get<{ Params: { toDid: string } }>('/api/diplomacy/messages/:toDid', async (req) => {
    const rows = db.prepare(`SELECT * FROM nova_diplomatic_messages WHERE to_did = ? ORDER BY sent_at DESC`).all(req.params.toDid);
    return { messages: rows };
  });

  // PATCH /api/diplomacy/messages/:msgId/ack — 수신 확인
  app.patch<{ Params: { msgId: string } }>('/api/diplomacy/messages/:msgId/ack', async (req, reply) => {
    const now = Math.floor(Date.now() / 1000);
    try {
      const info = db.prepare(`UPDATE nova_diplomatic_messages SET acknowledged_at = ? WHERE msg_id = ?`).run(now, req.params.msgId);
      if (info.changes === 0) return reply.code(404).send({ error: 'Message not found' });
      return reply.send({ ok: true, acknowledgedAt: now });
    } catch (err) { return reply.code(400).send({ error: (err as Error).message }); }
  });
}

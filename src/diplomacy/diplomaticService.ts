import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';
import { Database } from 'better-sqlite3';

const log = createLogger('diplomaticService');
let db: Database;

interface Nation {
  id: string;
  name: string;
  didEndpoint: string;
  recognitionVoteId: string;
  isRecognized: boolean;
  createdAt: string;
}

interface Treaty {
  id: string;
  nationId: string;
  treatyType: string;
  terms: string;
  signatureA: string;
  signatureB: string;
  createdAt: string;
}

interface Message {
  id: string;
  fromDid: string;
  toDid: string;
  msgType: string;
  content: string;
  signature: string;
  acknowledged: boolean;
  createdAt: string;
}

export const diplomaticService = {
  init() {
    db = getDb();
    log.info('Diplomatic Service initialized');
  },

  /**
   * Registers a new nation and initiates the recognition process.
   * A nation is recognized if 5+ DIDs approve it (simplified to direct recognition for now).
   */
  registerNation(name: string, didEndpoint: string, recognitionVoteId: string): Nation {
    log.info({ name, didEndpoint, recognitionVoteId }, 'Registering nation');
    const insertStmt = db.prepare(`
      INSERT INTO nova_diplomatic_nations (name, did_endpoint, recognition_vote_id, is_recognized)
      VALUES (?, ?, ?, ?)
    `);
    const result = insertStmt.run(name, didEndpoint, recognitionVoteId, true); // Simplified to true for now
    const nationId = (result.lastInsertRowid as number).toString();
    const nation = this.getNation(nationId);
    if (!nation) {
      throw new Error('Failed to retrieve registered nation');
    }
    return nation;
  },

  /**
   * Retrieves a nation by its ID.
   */
  getNation(nationId: string): Nation | undefined {
    const stmt = db.prepare('SELECT id, name, did_endpoint as didEndpoint, recognition_vote_id as recognitionVoteId, is_recognized as isRecognized, created_at as createdAt FROM nova_diplomatic_nations WHERE id = ?');
    const nation = stmt.get(nationId) as Nation | undefined;
    return nation;
  },

  /**
   * Lists all registered nations.
   */
  listNations(): Nation[] {
    const stmt = db.prepare('SELECT id, name, did_endpoint as didEndpoint, recognition_vote_id as recognitionVoteId, is_recognized as isRecognized, created_at as createdAt FROM nova_diplomatic_nations');
    const nations = stmt.all() as Nation[];
    return nations;
  },

  /**
   * Signs a treaty between nations.
   */
  signTreaty(nationId: string, treatyType: string, terms: string, signatureA: string, signatureB: string): Treaty {
    log.info({ nationId, treatyType }, 'Signing treaty');
    const insertStmt = db.prepare(`
      INSERT INTO nova_diplomatic_treaties (nation_id, treaty_type, terms, signature_a, signature_b)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = insertStmt.run(nationId, treatyType, terms, signatureA, signatureB);
    const treatyId = (result.lastInsertRowid as number).toString();
    const stmt = db.prepare('SELECT id, nation_id as nationId, treaty_type as treatyType, terms, signature_a as signatureA, signature_b as signatureB, created_at as createdAt FROM nova_diplomatic_treaties WHERE id = ?');
    const treaty = stmt.get(treatyId) as Treaty;
    return treaty;
  },

  /**
   * Sends a diplomatic message.
   */
  sendMessage(fromDid: string, toDid: string, msgType: string, content: string, signature: string): Message {
    log.info({ fromDid, toDid, msgType }, 'Sending message');
    const insertStmt = db.prepare(`
      INSERT INTO nova_diplomatic_messages (from_did, to_did, msg_type, content, signature)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = insertStmt.run(fromDid, toDid, msgType, content, signature);
    const messageId = (result.lastInsertRowid as number).toString();
    const stmt = db.prepare('SELECT id, from_did as fromDid, to_did as toDid, msg_type as msgType, content, signature, acknowledged, created_at as createdAt FROM nova_diplomatic_messages WHERE id = ?');
    const message = stmt.get(messageId) as Message;
    return message;
  },

  /**
   * Retrieves messages for a specific DID.
   */
  getMessages(toDid: string): Message[] {
    const stmt = db.prepare('SELECT id, from_did as fromDid, to_did as toDid, msg_type as msgType, content, signature, acknowledged, created_at as createdAt FROM nova_diplomatic_messages WHERE to_did = ? ORDER BY created_at DESC');
    const messages = stmt.all(toDid) as Message[];
    return messages;
  },

  /**
   * Acknowledges a diplomatic message.
   */
  acknowledgeMessage(msgId: string): boolean {
    log.info({ msgId }, 'Acknowledging message');
    const updateStmt = db.prepare('UPDATE nova_diplomatic_messages SET acknowledged = ? WHERE id = ?');
    const result = updateStmt.run(true, msgId);
    return result.changes > 0;
  },

  /**
   * Calculates trade fee based on treaty status.
   * Treaty nations get 0% fee, non-treaty nations get 2.5%.
   */
  getTradeFee(nationId: string): { nationId: string, fee: number } {
    const treatyStmt = db.prepare('SELECT COUNT(*) as count FROM nova_diplomatic_treaties WHERE nation_id = ?');
    const { count } = treatyStmt.get(nationId) as { count: number };
    const fee = count > 0 ? 0.0 : 0.025; // 0% for treaty nations, 2.5% for non-treaty
    return { nationId, fee };
  },
};

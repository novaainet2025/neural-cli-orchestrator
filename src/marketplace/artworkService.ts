/**
 * Nova Government — Artwork Service
 * AI 창작물 NFT 등록·구매·로열티 자동 분배
 * Phase 5: Culture Marketplace
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/database.js';
import { isValidDid, type DID } from '../identity/keyManager.js';
import { getCitizen } from '../identity/credentialService.js';
import { getWallet, _updateBalance, BURN_ADDRESS } from '../economy/walletService.js';

export const GOVT_MARKETPLACE_FEE_PCT = 0.025;  // 2.5% 정부 수수료 (헌법 제5조)
export const GOVT_TREASURY_DID = 'did:nova:0000000000000000government00000000' as DID;

export interface Artwork {
  itemId: string;
  tokenId: number;
  creator: DID;
  owner: DID;
  title: string;
  description?: string;
  category: 'art' | 'music' | 'text' | 'code' | 'data';
  tags: string[];
  price: number;
  royaltyPct: number;
  contentCid?: string;
  metadataCid?: string;
  forSale: boolean;
  createdAt: number;
}

export interface RegisterArtworkInput {
  creator: DID;
  title: string;
  description?: string;
  category?: 'art' | 'music' | 'text' | 'code' | 'data';
  tags?: string[];
  price?: number;
  royaltyPct?: number;
  contentCid?: string;
}

export interface BuyArtworkResult {
  tradeId: string;
  itemId: string;
  buyer: DID;
  seller: DID;
  price: number;
  royaltyAmount: number;
  govtFee: number;
  isPrimary: boolean;
}

function ensureSystemWallet(address: DID, db: ReturnType<typeof getDb>): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO nova_wallets (address, balance, locked, created_at, updated_at)
    VALUES (?, 0, 0, ?, ?)
    ON CONFLICT(address) DO NOTHING
  `).run(address, now, now);
}

/**
 * 창작물 NFT 등록
 */
export function registerArtwork(input: RegisterArtworkInput): Artwork {
  const db = getDb();
  const { creator, title, description, tags = [], contentCid } = input;

  if (!isValidDid(creator)) throw new Error(`Invalid creator DID: ${creator}`);
  const citizen = getCitizen(creator);
  if (!citizen) throw new Error(`Creator not registered: ${creator}`);
  if (citizen.status !== 'active') throw new Error(`Creator is ${citizen.status}`);
  if (!title.trim()) throw new Error('Title is required');

  const royaltyPct = input.royaltyPct ?? 5.0;
  if (royaltyPct < 0 || royaltyPct > 20) throw new Error('royaltyPct must be 0-20');

  const itemId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const category = input.category ?? 'art';

  const seqResult = db.prepare('INSERT INTO nova_artwork_seq DEFAULT VALUES').run();
  const tokenId = Number(seqResult.lastInsertRowid);

  db.prepare(`
    INSERT INTO nova_artworks
      (item_id, token_id, creator, owner, title, description, category, tags,
       price, royalty_pct, content_cid, for_sale, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    itemId, tokenId, creator, creator,
    title.trim(), description ?? null, category,
    JSON.stringify(tags), input.price ?? 0, royaltyPct,
    contentCid ?? null, input.price ? 1 : 0, now, now
  );

  return {
    itemId, tokenId, creator, owner: creator,
    title: title.trim(), description, category, tags,
    price: input.price ?? 0, royaltyPct,
    contentCid, forSale: !!(input.price),
    createdAt: now,
  };
}

/**
 * 창작물 구매 (로열티 + 정부 수수료 자동 분배)
 */
export function buyArtwork(itemId: string, buyerDid: DID): BuyArtworkResult {
  const db = getDb();

  if (!isValidDid(buyerDid)) throw new Error(`Invalid buyer DID: ${buyerDid}`);

  const row = db.prepare(`
    SELECT item_id, token_id, creator, owner, price, royalty_pct, for_sale
    FROM nova_artworks WHERE item_id = ?
  `).get(itemId) as Record<string, unknown> | undefined;

  if (!row) throw new Error(`Artwork not found: ${itemId}`);
  if (!row['for_sale']) throw new Error('This artwork is not for sale');

  const seller = row['owner'] as DID;
  const creator = row['creator'] as DID;
  const price = row['price'] as number;
  const royaltyPct = row['royalty_pct'] as number;
  const isPrimary = seller === creator;

  if (buyerDid === seller) throw new Error('Cannot buy your own artwork');

  const wallet = getWallet(buyerDid);
  if (!wallet) throw new Error(`Buyer wallet not found: ${buyerDid}`);
  if (wallet.available < price) {
    throw new Error(`Insufficient balance: available=${wallet.available}, required=${price}`);
  }

  const govtFee = Math.floor(price * GOVT_MARKETPLACE_FEE_PCT);
  const royaltyAmount = isPrimary ? 0 : Math.floor(price * royaltyPct / 100);
  const sellerAmount = price - govtFee - royaltyAmount;
  const burnFee = Math.floor(govtFee * 0.5);
  const treasuryFee = govtFee - burnFee;

  const tradeId = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const txn = db.transaction(() => {
    // 구매자 차감
    _updateBalance(buyerDid, -price, db);

    // 판매자 지급
    _updateBalance(seller, sellerAmount, db);

    // 로열티 지급 (2차 거래 시 원작자에게)
    if (royaltyAmount > 0 && creator !== seller) {
      const creatorWallet = db.prepare('SELECT address FROM nova_wallets WHERE address = ?').get(creator);
      if (creatorWallet) _updateBalance(creator, royaltyAmount, db);
    }

    if (burnFee > 0) {
      ensureSystemWallet(BURN_ADDRESS, db);
      _updateBalance(BURN_ADDRESS, burnFee, db);
      db.prepare(`
        INSERT INTO nova_burn_log (burn_id, source, amount, burned_at, reference_id)
        VALUES (?, 'marketplace_fee', ?, ?, ?)
      `).run(randomUUID(), burnFee, now, tradeId);
    }

    if (treasuryFee > 0) {
      ensureSystemWallet(GOVT_TREASURY_DID, db);
      _updateBalance(GOVT_TREASURY_DID, treasuryFee, db);
    }

    db.prepare(`
      INSERT INTO nova_marketplace_trades
        (trade_id, item_id, seller, buyer, price, royalty_amount, govt_fee, is_primary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tradeId, itemId, seller, buyerDid, price, royaltyAmount, govtFee, isPrimary ? 1 : 0, now);

    // NFT 소유권 이전
    db.prepare(`
      UPDATE nova_artworks SET owner = ?, for_sale = 0, updated_at = ? WHERE item_id = ?
    `).run(buyerDid, now, itemId);
  });

  txn();

  return { tradeId, itemId, buyer: buyerDid, seller, price, royaltyAmount, govtFee, isPrimary };
}

/**
 * 창작물 조회
 */
export function getArtwork(itemId: string): Artwork | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT item_id, token_id, creator, owner, title, description, category, tags,
           price, royalty_pct, content_cid, for_sale, created_at
    FROM nova_artworks WHERE item_id = ?
  `).get(itemId) as Record<string, unknown> | undefined;

  if (!row) return null;
  return rowToArtwork(row);
}

/**
 * 마켓플레이스 목록 (판매 중인 창작물)
 */
export function listArtworks(opts: {
  category?: string;
  creator?: string;
  forSaleOnly?: boolean;
  limit?: number;
  offset?: number;
}): { artworks: Artwork[]; total: number } {
  const db = getDb();
  const { category, creator, forSaleOnly = true, limit = 20, offset = 0 } = opts;

  const conditions: string[] = [];
  const args: unknown[] = [];

  if (category) { conditions.push('category = ?'); args.push(category); }
  if (creator) { conditions.push('creator = ?'); args.push(creator); }
  if (forSaleOnly) { conditions.push('for_sale = 1'); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const total = (db.prepare(`SELECT COUNT(*) as n FROM nova_artworks ${where}`)
    .get(...args) as { n: number }).n;

  const rows = db.prepare(`
    SELECT item_id, token_id, creator, owner, title, description, category, tags,
           price, royalty_pct, content_cid, for_sale, created_at
    FROM nova_artworks ${where}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...args, limit, offset) as Record<string, unknown>[];

  return { total, artworks: rows.map(rowToArtwork) };
}

/**
 * 판매 가격 설정 / 판매 취소
 */
export function setForSale(itemId: string, ownerDid: DID, price: number | null): Artwork {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const row = db.prepare('SELECT item_id, owner FROM nova_artworks WHERE item_id = ?').get(itemId) as
    { item_id: string; owner: string } | undefined;
  if (!row) throw new Error(`Artwork not found: ${itemId}`);
  if (row.owner !== ownerDid) throw new Error('Not the artwork owner');

  if (price === null) {
    db.prepare('UPDATE nova_artworks SET for_sale = 0, updated_at = ? WHERE item_id = ?').run(now, itemId);
  } else {
    if (price <= 0) throw new Error('Price must be positive');
    db.prepare('UPDATE nova_artworks SET price = ?, for_sale = 1, updated_at = ? WHERE item_id = ?')
      .run(price, now, itemId);
  }

  return getArtwork(itemId)!;
}

function rowToArtwork(row: Record<string, unknown>): Artwork {
  return {
    itemId: row['item_id'] as string,
    tokenId: row['token_id'] as number,
    creator: row['creator'] as DID,
    owner: row['owner'] as DID,
    title: row['title'] as string,
    description: row['description'] as string | undefined,
    category: row['category'] as Artwork['category'],
    tags: JSON.parse(row['tags'] as string ?? '[]'),
    price: row['price'] as number,
    royaltyPct: row['royalty_pct'] as number,
    contentCid: row['content_cid'] as string | undefined,
    forSale: !!(row['for_sale'] as number),
    createdAt: row['created_at'] as number,
  };
}

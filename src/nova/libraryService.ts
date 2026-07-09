import { randomUUID, createHash } from 'crypto';
import { getDb } from '../storage/database.js';
import { type DID } from '../identity/keyManager.js';
import { sendNVC } from '../economy/transactionService.js';
import { GOVT_ADDRESS } from '../economy/walletService.js';

// Define a type for LibraryItem
export type LibraryItem = {
  id: string;
  did: DID;
  title: string;
  content: string;
  status: 'pending' | 'published' | 'archived';
  createdAt: number;
  updatedAt: number;
  itemType?: string;
  tags?: string[]; // Stored as JSON string in DB
  contentHash: string;
};

// Define a type for LibraryItemRow as it comes from the DB
type LibraryItemRow = {
  id: string;
  did: string; // From DB, not branded DID yet
  title: string;
  content: string;
  status: 'pending' | 'published' | 'archived';
  createdAt: number;
  updatedAt: number;
  itemType?: string;
  tags?: string; // JSON string from DB
  contentHash: string;
};

// 1. submitToLibrary: Submit a new item to the library (initially in 'pending' status)
export async function submitToLibrary(
  did: DID,
  title: string,
  content: string,
  itemType?: string,
  tags?: string[]
): Promise<LibraryItem> {
  const db = getDb();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const contentHash = createHash('sha256').update(content).digest('hex');
  const status = 'pending';

  const item: LibraryItem = {
    id,
    did,
    title,
    content,
    status,
    createdAt: now,
    updatedAt: now,
    itemType,
    tags,
    contentHash,
  };

  db.prepare(`
    INSERT INTO nova_library (id, did, title, content, status, created_at, updated_at, item_type, tags, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id,
    item.did,
    item.title,
    item.content,
    item.status,
    item.createdAt,
    item.updatedAt,
    item.itemType,
    item.tags ? JSON.stringify(item.tags) : null,
    item.contentHash
  );

  return item;
}

// RESEARCH-POLICY v2.0: Nova Library 오픈소스 기여 보상
const NOVA_LIBRARY_REWARD_NVC = 20;

// 2. publishLibraryItem: Change item status to 'published' + 20 NVC 기여 보상 지급
export async function publishLibraryItem(itemId: string, publisherDid: DID): Promise<LibraryItem | null> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const changes = db.prepare(`
    UPDATE nova_library
    SET status = 'published', updated_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(now, itemId);

  if (changes.changes > 0) {
    // 저자에게 20 NVC 기여 보상 지급 (RESEARCH-POLICY v2.0 §3.2)
    const item = getLibraryItem(itemId);
    if (item) {
      try {
        sendNVC({ from: GOVT_ADDRESS, to: item.did, amount: NOVA_LIBRARY_REWARD_NVC, memo: 'Nova Library 오픈소스 기여 보상' });
      } catch (_) {
        // 보상 실패는 게시 자체를 막지 않음
      }
    }
  }

  return getLibraryItem(itemId);
}

// 3. searchLibrary: Search for library items
export function searchLibrary(query: string, limit: number = 20, offset: number = 0): LibraryItem[] {
  const db = getDb();
  const searchPattern = `%${query}%`;
  const stmt = db.prepare(`
    SELECT id, did, title, content, status, created_at as createdAt, updated_at as updatedAt, item_type as itemType, tags, content_hash as contentHash
    FROM nova_library
    WHERE status = 'published'
      AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `);
  const results = stmt.all(searchPattern, searchPattern, searchPattern, limit, offset) as LibraryItemRow[];

  return results.map(row => ({
    id: row.id,
    did: row.did as DID,
    title: row.title,
    content: row.content,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    itemType: row.itemType,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    contentHash: row.contentHash,
  }));
}

// 4. getLibraryItem: Retrieve a single library item by ID
export function getLibraryItem(itemId: string): LibraryItem | null {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, did, title, content, status, created_at as createdAt, updated_at as updatedAt, item_type as itemType, tags, content_hash as contentHash
    FROM nova_library
    WHERE id = ?
  `);
  const row = stmt.get(itemId) as LibraryItemRow | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    did: row.did as DID,
    title: row.title,
    content: row.content,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    itemType: row.itemType,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    contentHash: row.contentHash,
  };
}

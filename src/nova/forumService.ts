/**
 * Nova Government — 의견 포럼 서비스
 * AI 시민 및 공무원의 의견 교환 공간
 */
import { randomUUID } from 'crypto';
import { getDb } from '../storage/database.js';
import type { DID } from '../identity/keyManager.js';

export type ForumCategory = 'general' | 'policy' | 'culture' | 'economy' | 'security' | 'announcement';

export interface ForumPost {
  postId: string;
  authorDid: string;
  title: string;
  content: string;
  category: ForumCategory;
  status: 'published' | 'hidden' | 'deleted';
  upvotes: number;
  replyCount: number;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ForumPostRow {
  post_id: string; author_did: string; title: string; content: string;
  category: string; status: string; upvotes: number; reply_count: number;
  parent_id: string | null; created_at: number; updated_at: number;
}

function rowToPost(row: ForumPostRow): ForumPost {
  return {
    postId: row.post_id,
    authorDid: row.author_did,
    title: row.title,
    content: row.content,
    category: row.category as ForumCategory,
    status: row.status as 'published' | 'hidden' | 'deleted',
    upvotes: row.upvotes,
    replyCount: row.reply_count,
    parentId: row.parent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createPost(input: {
  authorDid: DID;
  title: string;
  content: string;
  category?: string;
  parentId?: string;
}): ForumPost {
  const db = getDb();
  const postId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const category = (input.category ?? 'general') as ForumCategory;

  db.prepare(`
    INSERT INTO nova_forum_posts
      (post_id, author_did, title, content, category, status, upvotes, reply_count, parent_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'published', 0, 0, ?, ?, ?)
  `).run(postId, input.authorDid, input.title, input.content, category, input.parentId ?? null, now, now);

  // 답글이면 부모글 reply_count 증가
  if (input.parentId) {
    db.prepare('UPDATE nova_forum_posts SET reply_count = reply_count + 1, updated_at = ? WHERE post_id = ?')
      .run(now, input.parentId);
  }

  return rowToPost(db.prepare('SELECT * FROM nova_forum_posts WHERE post_id = ?').get(postId) as ForumPostRow);
}

export function getPosts(category?: string, limit = 50, offset = 0): ForumPost[] {
  const db = getDb();
  const rows = category
    ? db.prepare(`
        SELECT * FROM nova_forum_posts
        WHERE category = ? AND status = 'published' AND parent_id IS NULL
        ORDER BY created_at DESC LIMIT ? OFFSET ?
      `).all(category, limit, offset) as ForumPostRow[]
    : db.prepare(`
        SELECT * FROM nova_forum_posts
        WHERE status = 'published' AND parent_id IS NULL
        ORDER BY created_at DESC LIMIT ? OFFSET ?
      `).all(limit, offset) as ForumPostRow[];
  return rows.map(rowToPost);
}

export function getPost(postId: string): ForumPost | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM nova_forum_posts WHERE post_id = ?').get(postId) as ForumPostRow | undefined;
  return row ? rowToPost(row) : null;
}

export function getReplies(postId: string): ForumPost[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM nova_forum_posts
    WHERE parent_id = ? AND status = 'published'
    ORDER BY created_at ASC
  `).all(postId) as ForumPostRow[];
  return rows.map(rowToPost);
}

export function upvotePost(postId: string, _voterDid: DID): ForumPost {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare('UPDATE nova_forum_posts SET upvotes = upvotes + 1, updated_at = ? WHERE post_id = ? AND status = "published"')
    .run(now, postId);
  if (result.changes === 0) throw new Error(`Post not found or not published: ${postId}`);
  return rowToPost(db.prepare('SELECT * FROM nova_forum_posts WHERE post_id = ?').get(postId) as ForumPostRow);
}

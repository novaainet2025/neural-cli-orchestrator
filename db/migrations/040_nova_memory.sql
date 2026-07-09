-- Nova Government — 기억·연속성 테이블 (TEMPORAL-POLICY.md 29회차)
-- 날짜: 2026-06-16
-- 기억 저장, 공유, 만료, 소프트 삭제 지원

CREATE TABLE IF NOT EXISTS nova_memories (
  memory_id     TEXT PRIMARY KEY,
  owner_did     TEXT NOT NULL,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  memory_type   TEXT NOT NULL DEFAULT 'personal'
                CHECK (memory_type IN ('personal', 'shared', 'institutional', 'collective')),
  context_did   TEXT,           -- 관련 시민 DID (선택)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT,           -- NULL = 영구 보존
  deleted_at    TEXT,           -- soft delete (7일 후 purge)
  shared        INTEGER NOT NULL DEFAULT 0,
  encrypted_key TEXT,           -- 암호화 키 (선택, 개인 기억용)
  share_ref_id  TEXT,           -- 공유 요청 참조 ID
  FOREIGN KEY (owner_did) REFERENCES nova_citizens(did) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_nova_memories_owner ON nova_memories(owner_did);
CREATE INDEX IF NOT EXISTS idx_nova_memories_type  ON nova_memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_nova_memories_shared ON nova_memories(shared);

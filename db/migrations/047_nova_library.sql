-- db/migrations/047_nova_library.sql

CREATE TABLE IF NOT EXISTS nova_library (
    id TEXT PRIMARY KEY NOT NULL,
    did TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'published', 'archived'
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    item_type TEXT,
    tags TEXT,
    content_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nova_library_did ON nova_library (did);
CREATE INDEX IF NOT EXISTS idx_nova_library_status ON nova_library (status);
CREATE INDEX IF NOT EXISTS idx_nova_library_created_at ON nova_library (created_at);
CREATE INDEX IF NOT EXISTS idx_nova_library_title ON nova_library (title COLLATE NOCASE);
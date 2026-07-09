-- 025: Semantic memory + dynamic skills for Mithosis-level surpass
-- Semantic memory: 자연어 쿼리로 관련 과거 결과 검색
CREATE TABLE IF NOT EXISTS semantic_memory (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,           -- 저장할 텍스트 (결과, 요약 등)
  summary TEXT NOT NULL DEFAULT '', -- 100자 요약 (빠른 검색용)
  tags TEXT NOT NULL DEFAULT '[]',  -- JSON 태그 배열
  source_agent TEXT,               -- 생성한 에이전트
  task_type TEXT DEFAULT 'general',
  keyword_vector TEXT NOT NULL DEFAULT '[]', -- JSON: 키워드 빈도 배열 [{word,freq}]
  importance REAL NOT NULL DEFAULT 0.5,      -- 0-1: 중요도 (decay 적용)
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_semantic_mem_type ON semantic_memory(task_type, importance DESC);
CREATE INDEX IF NOT EXISTS idx_semantic_mem_agent ON semantic_memory(source_agent, created_at DESC);

-- Dynamic skills: 런타임 스킬 자동 생성·등록
CREATE TABLE IF NOT EXISTS dynamic_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,         -- 스킬 이름 (슬래시 커맨드로 사용)
  description TEXT NOT NULL,
  trigger_keywords TEXT NOT NULL DEFAULT '[]', -- JSON: 자동 트리거 키워드
  pipeline TEXT NOT NULL DEFAULT '[]',         -- JSON: [{step, agentId, promptTemplate}]
  quality_threshold REAL NOT NULL DEFAULT 60,
  usage_count INTEGER NOT NULL DEFAULT 0,
  avg_quality REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  auto_generated INTEGER NOT NULL DEFAULT 1,   -- 0=수동, 1=자동생성
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dynamic_skills_active ON dynamic_skills(is_active, usage_count DESC);

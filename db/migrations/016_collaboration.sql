-- Phase 3: 그룹 지성 협업 세션
CREATE TABLE IF NOT EXISTS collaborations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL DEFAULT 'brainstorm',
  -- type: 'brainstorm' | 'consensus' | 'parallel_work' | 'review'
  status TEXT NOT NULL DEFAULT 'open',
  -- status: 'open' | 'voting' | 'closed'
  creator_session_id TEXT NOT NULL,
  creator_agent_id TEXT NOT NULL,
  participant_session_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
  min_participants INTEGER NOT NULL DEFAULT 2,
  max_participants INTEGER,
  result TEXT,          -- 최종 합의 결과
  result_method TEXT,   -- 'majority' | 'unanimous' | 'weighted' | 'facilitator'
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME
);

-- 협업 기여(contribution): 참여자가 제출한 아이디어/결과물
CREATE TABLE IF NOT EXISTS collab_contributions (
  id TEXT PRIMARY KEY,
  collaboration_id TEXT NOT NULL REFERENCES collaborations(id),
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text', -- 'text' | 'code' | 'plan' | 'vote'
  score INTEGER NOT NULL DEFAULT 0,  -- 다른 참여자 투표 점수
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 투표 기록
CREATE TABLE IF NOT EXISTS collab_votes (
  id TEXT PRIMARY KEY,
  collaboration_id TEXT NOT NULL REFERENCES collaborations(id),
  contribution_id TEXT NOT NULL REFERENCES collab_contributions(id),
  voter_session_id TEXT NOT NULL,
  vote INTEGER NOT NULL DEFAULT 1, -- 1=up, -1=down
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(contribution_id, voter_session_id)
);

CREATE INDEX IF NOT EXISTS idx_collab_contrib ON collab_contributions(collaboration_id);
CREATE INDEX IF NOT EXISTS idx_collab_votes ON collab_votes(collaboration_id);
CREATE INDEX IF NOT EXISTS idx_collab_status ON collaborations(status);

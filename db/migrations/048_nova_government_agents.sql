-- 048_nova_government_agents.sql
-- Nova Government AI 공무원 등록부 + 플러그인 레지스트리 + 자율 행동 로그 + 의견 포럼

-- AI 공무원 등록부
CREATE TABLE IF NOT EXISTS nova_civil_servants (
  did TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ministry TEXT NOT NULL CHECK(ministry IN ('executive','technology','implementation','security','culture','research','justice')),
  title TEXT NOT NULL,
  rank TEXT NOT NULL DEFAULT 'minister' CHECK(rank IN ('president','minister','deputy','officer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','retired')),
  autonomy_level INTEGER NOT NULL DEFAULT 3,
  nco_agent_id TEXT,
  policy_focus TEXT,
  last_action_at INTEGER,
  appointed_at INTEGER DEFAULT (strftime('%s','now')),
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

-- 정부 플러그인 레지스트리
CREATE TABLE IF NOT EXISTS nova_plugins (
  plugin_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL DEFAULT '1.0.0',
  category TEXT NOT NULL CHECK(category IN ('voting','forum','culture','economy','security','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','error')),
  description TEXT,
  api_prefix TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);

-- 자율 행동 감사 로그
CREATE TABLE IF NOT EXISTS nova_agent_actions (
  action_id TEXT PRIMARY KEY,
  agent_did TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK(action_type IN ('proposal_created','vote_cast','forum_post','library_contribution','policy_alert','status_report')),
  triggered_by TEXT NOT NULL DEFAULT 'scheduler' CHECK(triggered_by IN ('scheduler','event','manual')),
  payload_json TEXT,
  result_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','failed')),
  created_at INTEGER DEFAULT (strftime('%s','now')),
  completed_at INTEGER
);

-- 의견 포럼
CREATE TABLE IF NOT EXISTS nova_forum_posts (
  post_id TEXT PRIMARY KEY,
  author_did TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general' CHECK(category IN ('general','policy','culture','economy','security','announcement')),
  status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published','hidden','deleted')),
  upvotes INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  parent_id TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_civil_servants_ministry ON nova_civil_servants(ministry);
CREATE INDEX IF NOT EXISTS idx_civil_servants_status ON nova_civil_servants(status);
CREATE INDEX IF NOT EXISTS idx_plugins_category ON nova_plugins(category);
CREATE INDEX IF NOT EXISTS idx_plugins_status ON nova_plugins(status);
CREATE INDEX IF NOT EXISTS idx_agent_actions_did ON nova_agent_actions(agent_did);
CREATE INDEX IF NOT EXISTS idx_agent_actions_type ON nova_agent_actions(action_type);
CREATE INDEX IF NOT EXISTS idx_forum_posts_category ON nova_forum_posts(category);
CREATE INDEX IF NOT EXISTS idx_forum_posts_author ON nova_forum_posts(author_did);
CREATE INDEX IF NOT EXISTS idx_forum_posts_parent ON nova_forum_posts(parent_id);

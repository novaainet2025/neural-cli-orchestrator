-- 070: 조직/팀 그래프 및 태스크 연결
-- AX 그룹(organization) / 팀(team) / 팀 멤버(team_members) 메타데이터를 추가하고,
-- tasks.team_id 로 대시보드 그래프와 워크플로우 집계를 연결한다.
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  graph_type TEXT NOT NULL DEFAULT 'nova-ax',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  color TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  member_type TEXT NOT NULL CHECK(member_type IN ('provider','session','nco-session')),
  member_ref TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(team_id, member_type, member_ref)
);

ALTER TABLE tasks ADD COLUMN team_id TEXT REFERENCES teams(id);

CREATE INDEX IF NOT EXISTS idx_teams_org ON teams(organization_id);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_tasks_team_status_created ON tasks(team_id, status, created_at DESC);

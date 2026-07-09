CREATE TABLE IF NOT EXISTS work_reports (
  id TEXT PRIMARY KEY,
  report_date TEXT NOT NULL,
  report_slot TEXT NOT NULL CHECK(report_slot IN ('am', 'pm')),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('organization', 'team')),
  subject_id TEXT NOT NULL,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  org_root_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  org_parent_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  org_path TEXT NOT NULL,
  org_depth INTEGER NOT NULL DEFAULT 0,
  unit_level TEXT NOT NULL CHECK(unit_level IN ('company', 'department', 'team')),
  source_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'submitted', 'late', 'missed', 'waived')) DEFAULT 'pending',
  due_at TEXT NOT NULL,
  submitted_at TEXT,
  lateness_minutes INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  body_md TEXT,
  summary_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(subject_kind, subject_id, report_date, report_slot)
);

CREATE INDEX IF NOT EXISTS idx_work_reports_date_slot
  ON work_reports(report_date DESC, report_slot, status);

CREATE INDEX IF NOT EXISTS idx_work_reports_org_date
  ON work_reports(organization_id, report_date DESC, report_slot);

CREATE INDEX IF NOT EXISTS idx_work_reports_team_date
  ON work_reports(team_id, report_date DESC, report_slot)
  WHERE team_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_work_reports_status_due
  ON work_reports(status, due_at);

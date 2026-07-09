CREATE TABLE IF NOT EXISTS attendance_records (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  work_date TEXT NOT NULL,
  check_in_at TEXT,
  check_out_at TEXT,
  status TEXT NOT NULL DEFAULT 'present',
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(employee_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_records_employee_id
  ON attendance_records(employee_id);

CREATE INDEX IF NOT EXISTS idx_attendance_records_work_date
  ON attendance_records(work_date DESC);

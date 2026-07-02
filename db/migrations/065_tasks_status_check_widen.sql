-- 005_tasks.sql CHECK에 상태기계(task-state.ts)가 허용하는 'queued','timed_out'이 빠져 있어
-- 해당 상태로 UPDATE/INSERT 시 SQLITE_CONSTRAINT 발생하는 잠재 버그 수정 (kangnote T1 발견, 2026-07-03).
-- SQLite는 CHECK 변경 불가 → 테이블 재생성 방식.
CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'task',
  prompt TEXT NOT NULL,
  system_prompt TEXT,
  assigned_to TEXT,
  delegated_from TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','queued','assigned','running','streaming','reviewing','completed','failed','timed_out','cancelled')),
  progress REAL DEFAULT 0,
  result_json TEXT,
  response TEXT,
  error TEXT,
  workspace_id TEXT DEFAULT 'default',
  parent_task_id TEXT,
  priority INTEGER DEFAULT 0,
  metadata_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  spawned_by_cli TEXT,
  verifier_json TEXT,
  verifier_result_json TEXT
);
INSERT INTO tasks_new
  SELECT id, mode, prompt, system_prompt, assigned_to, delegated_from, status, progress,
         result_json, response, error, workspace_id, parent_task_id, priority, metadata_json,
         created_at, updated_at, completed_at, spawned_by_cli, verifier_json, verifier_result_json
  FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX idx_tasks_assigned ON tasks(assigned_to, status);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_created ON tasks(created_at DESC);

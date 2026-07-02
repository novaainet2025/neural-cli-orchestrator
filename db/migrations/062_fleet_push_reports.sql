CREATE TABLE IF NOT EXISTS fleet_push_reports (
  host TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  ts TEXT NOT NULL
);

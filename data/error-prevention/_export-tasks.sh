#!/bin/sh
cd /Users/nova-ai/project/nco
sqlite3 db/nco.db "SELECT id,status,assigned_to,substr(error,1,120) FROM tasks WHERE team_id='team_hr-incubator-2026-w30' AND julianday(created_at)>=julianday('now','-48 hours') ORDER BY created_at;" > data/error-prevention/hr-incubator-2026-w30-tasks-48h.txt

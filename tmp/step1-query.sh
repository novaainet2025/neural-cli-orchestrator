#!/bin/sh
sqlite3 /Users/nova-ai/project/nco/db/nco.db "SELECT id, report_date, report_slot, status, length(coalesce(body_md,'')) as body_len FROM work_reports WHERE team_id='team_tech-port-02-safety-license' ORDER BY report_date, report_slot;"

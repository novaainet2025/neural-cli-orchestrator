#!/bin/bash
cd /Users/nova-ai/project/nco
sqlite3 db/nco.db ".schema organizations"
sqlite3 db/nco.db ".schema teams"
sqlite3 db/nco.db ".schema team_lifecycle_profiles"
sqlite3 db/nco.db ".schema required_organizations"
sqlite3 db/nco.db ".schema required_capabilities"
sqlite3 db/nco.db ".schema organization_design_audits"
sqlite3 db/nco.db ".schema team_consolidations"
sqlite3 db/nco.db "SELECT id,name,slug,graph_type,manager,parent_id,is_always_on,is_active FROM organizations WHERE id IN ('org_nco-command','org_nco-evolution','org_nco-engineering','org_nco-assurance','org_nco-government');"
sqlite3 db/nco.db "SELECT id,organization_id,name,slug,is_active,lead FROM teams WHERE id LIKE 'team_gov-%' ORDER BY id;"
sqlite3 db/nco.db "SELECT id,organization_id,name,slug,is_active,lead FROM teams WHERE id LIKE 'team_kd-%' ORDER BY id;"
sqlite3 db/nco.db "SELECT COUNT(*) FROM teams WHERE id IN ('team_gov-command-strategic','team_gov-command-intake','team_gov-command-routing','team_gov-command-collaboration','team_gov-command-incident','team_gov-evolution-learning','team_gov-evolution-memory','team_gov-evolution-evaluation','team_gov-evolution-improvement','team_gov-evolution-skills','team_gov-engineering-experts','team_gov-engineering-architecture','team_gov-engineering-build','team_gov-engineering-release','team_gov-engineering-reliability','team_gov-assurance-verification','team_gov-assurance-safety','team_gov-assurance-redteam','team_gov-assurance-audit','team_gov-assurance-resilience','team_gov-government-constitution','team_gov-government-rights','team_gov-government-hr','team_gov-government-treasury','team_gov-government-transparency');"
sqlite3 db/nco.db "SELECT filename FROM schema_migrations WHERE filename LIKE '%091%' OR filename LIKE '%088%' OR filename LIKE '%086%';"

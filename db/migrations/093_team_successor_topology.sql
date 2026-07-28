-- db/migrations/093_team_successor_topology.sql

PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

-- 1. Create 9 New teams in required_capabilities
INSERT OR IGNORE INTO required_capabilities (id, organization_id, name, slug, description, color, lead, charter, is_always_on, protected, is_active) VALUES
('req_computer_use_assurance_2026', 'org_computer-use', '컴퓨터 제어 감사·안전팀', 'computer-use-safety', '독립 안전·감사', '#FF5722', 'claude-3-5-sonnet', '컴퓨터 제어 시 발생할 수 있는 위험을 사전 차단하고 감사함. 화면 제어 등 직접 실행 권한 금지.', 1, 1, 1),
('req_research_strategy_2026', 'org_research', '리서치 전략 기획팀', 'research-strategy', '연구 질문·범위·방법론', '#2196F3', 'claude-3-5-sonnet', '연구 질문 정의, 범위 설정 및 방법론 설계', 1, 1, 1),
('req_cli_experience_2026', 'org_nova-cli', 'CLI 경험 설계팀', 'cli-design', 'CLI 경험 설계', '#4CAF50', 'claude-3-5-sonnet', 'CLI 사용자 경험 설계 및 최적화', 1, 1, 1),
('req_cli_assurance_2026', 'org_nova-cli', 'CLI QA팀', 'cli-qa', '독립 QA', '#F44336', 'claude-3-5-sonnet', 'CLI 기능 및 안정성 독립 QA 보장', 1, 1, 1),
('req_content_strategy_2026', 'org_sns-blog', '콘텐츠 전략 기획팀', 'content-planning', '콘텐츠 전략', '#9C27B0', 'claude-3-5-sonnet', '콘텐츠 기획 및 배포 전략 수립', 1, 1, 1),
('req_tech_port_06_decision_2026', 'org_technology-porting', '포팅 대안 토론팀', 'tech-port-06-improvement-debate', '대안 토론·결정', '#3F51B5', 'claude-3-5-sonnet', '포팅 기술 대안 토론 및 최종 결정. 08과 독립 인력 구성.', 1, 1, 1),
('req_tech_port_08_delivery_2026', 'org_technology-porting', '승인된 이식 구현팀', 'tech-port-08-migration-implementation', '승인된 이식 구현', '#009688', 'claude-3-5-sonnet', '승인된 기술 이식 계획의 구현 담당. 06과 독립 인력 구성.', 1, 1, 1),
('req_ax_business_operations_2026', 'org_nova-ax', 'AX 비즈니스 운영팀', 'ax-business-operations', 'analytics+CFO+sales 통합', '#FF9800', 'claude-3-5-sonnet', '분석, 재무, 영업 기능을 통합하여 운영', 1, 1, 1),
('req_ax_decision_coordination_2026', 'org_nova-ax', 'AX 의사결정 조정팀', 'ax-decision-coordination', 'autonomy+collaboration+discussion 통합', '#795548', 'claude-3-5-sonnet', '자율성 조율, 협력, 토론 통합 관리', 1, 1, 1);

-- Promotion of existing teams: team_content-quality, team_kd-quality-hygiene
INSERT OR IGNORE INTO required_capabilities (id, organization_id, name, slug, description, color, lead, charter, is_always_on, protected, is_active) VALUES
('req_content_quality', 'org_sns-blog', '콘텐츠 품질 검수팀', 'content-quality', '콘텐츠 품질 감사 승계', '#607D8B', 'claude-3-5-sonnet', '콘텐츠 품질 관리 및 검수', 1, 1, 1),
('req_kd_quality_hygiene', 'org_kd', '지식 문서 품질팀', 'kd-quality-hygiene', 'KD 5개 팀 승계', '#607D8B', 'claude-3-5-sonnet', '지식 문서의 일관성 및 품질 관리', 1, 1, 1);

UPDATE required_capabilities SET protected = 1 WHERE slug IN ('content-quality', 'kd-quality-hygiene');

-- Insert 9 new teams into teams table
INSERT OR IGNORE INTO teams (id, organization_id, name, slug, description, color, lead, charter, is_always_on, is_active) VALUES
('team_computer-use-assurance-2026', 'org_computer-use', '컴퓨터 제어 감사·안전팀', 'computer-use-safety', '독립 안전·감사', '#FF5722', 'claude-3-5-sonnet', '컴퓨터 제어 시 발생할 수 있는 위험을 사전 차단하고 감사함. 화면 제어 등 직접 실행 권한 금지.', 1, 1),
('team_research-strategy-2026', 'org_research', '리서치 전략 기획팀', 'research-strategy', '연구 질문·범위·방법론', '#2196F3', 'claude-3-5-sonnet', '연구 질문 정의, 범위 설정 및 방법론 설계', 1, 1),
('team_cli-experience-2026', 'org_nova-cli', 'CLI 경험 설계팀', 'cli-design', 'CLI 경험 설계', '#4CAF50', 'claude-3-5-sonnet', 'CLI 사용자 경험 설계 및 최적화', 1, 1),
('team_cli-assurance-2026', 'org_nova-cli', 'CLI QA팀', 'cli-qa', '독립 QA', '#F44336', 'claude-3-5-sonnet', 'CLI 기능 및 안정성 독립 QA 보장', 1, 1),
('team_content-strategy-2026', 'org_sns-blog', '콘텐츠 전략 기획팀', 'content-planning', '콘텐츠 전략', '#9C27B0', 'claude-3-5-sonnet', '콘텐츠 기획 및 배포 전략 수립', 1, 1),
('team_tech-port-06-decision-2026', 'org_technology-porting', '포팅 대안 토론팀', 'tech-port-06-improvement-debate', '대안 토론·결정', '#3F51B5', 'claude-3-5-sonnet', '포팅 기술 대안 토론 및 최종 결정. 08과 독립 인력 구성.', 1, 1),
('team_tech-port-08-delivery-2026', 'org_technology-porting', '승인된 이식 구현팀', 'tech-port-08-migration-implementation', '승인된 이식 구현', '#009688', 'claude-3-5-sonnet', '승인된 기술 이식 계획의 구현 담당. 06과 독립 인력 구성.', 1, 1),
('team_ax-business-operations-2026', 'org_nova-ax', 'AX 비즈니스 운영팀', 'ax-business-operations', 'analytics+CFO+sales 통합', '#FF9800', 'claude-3-5-sonnet', '분석, 재무, 영업 기능을 통합하여 운영', 1, 1),
('team_ax-decision-coordination-2026', 'org_nova-ax', 'AX 의사결정 조정팀', 'ax-decision-coordination', 'autonomy+collaboration+discussion 통합', '#795548', 'claude-3-5-sonnet', '자율성 조율, 협력, 토론 통합 관리', 1, 1);

-- Insert into team_lifecycle_profiles
INSERT OR IGNORE INTO team_lifecycle_profiles (team_id, status, protected)
SELECT id, 'active', 1 FROM teams 
WHERE id IN (
  'team_computer-use-assurance-2026', 'team_research-strategy-2026', 'team_cli-experience-2026',
  'team_cli-assurance-2026', 'team_content-strategy-2026', 'team_tech-port-06-decision-2026',
  'team_tech-port-08-delivery-2026', 'team_ax-business-operations-2026', 'team_ax-decision-coordination-2026'
);

-- Protect existing ones just in case
UPDATE team_lifecycle_profiles SET protected = 1 WHERE team_id IN ('team_content-quality', 'team_kd-quality-hygiene');

-- Insert at least 3 providers per team
INSERT OR IGNORE INTO team_members (id, team_id, member_type, member_ref)
SELECT 
  'mem_' || t.id || '_' || num.n, 
  t.id, 
  'provider', 
  CASE num.n WHEN 1 THEN 'gpt-4o' WHEN 2 THEN 'claude-3-5-sonnet' WHEN 3 THEN 'gemini-1.5-pro' END
FROM teams t
CROSS JOIN (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3) num
WHERE t.id IN (
  'team_computer-use-assurance-2026', 'team_research-strategy-2026', 'team_cli-experience-2026',
  'team_cli-assurance-2026', 'team_content-strategy-2026', 'team_tech-port-06-decision-2026',
  'team_tech-port-08-delivery-2026', 'team_ax-business-operations-2026', 'team_ax-decision-coordination-2026'
);

-- Temp table for mapping
CREATE TEMP TABLE old_to_new_mapping (old_id TEXT, new_id TEXT);
INSERT INTO old_to_new_mapping VALUES
('team_content-planning', 'team_content-strategy-2026'),
('team_research-strategy', 'team_research-strategy-2026'),
('team_computer-use-safety', 'team_computer-use-assurance-2026'),
('team_cli-design', 'team_cli-experience-2026'),
('team_cli-qa', 'team_cli-assurance-2026'),
('team_analytics-lead', 'team_ax-business-operations-2026'),
('team_cfo', 'team_ax-business-operations-2026'),
('team_sales-director', 'team_ax-business-operations-2026'),
('team_autonomy-controller', 'team_ax-decision-coordination-2026'),
('team_ax-collab', 'team_ax-decision-coordination-2026'),
('team_ax-discuss', 'team_ax-decision-coordination-2026'),
('team_legal-counsel', 'team_governance-officer'),
('team_quality-audit', 'team_content-quality'),
('team_tech-port-06-improvement-debate', 'team_tech-port-06-decision-2026'),
('team_tech-port-08-migration-implementation', 'team_tech-port-08-delivery-2026'),
('team_kd-memory', 'team_kd-quality-hygiene'),
('team_kd-harness', 'team_kd-quality-hygiene'),
('team_kd-obsidian', 'team_kd-quality-hygiene'),
('team_kd-provider', 'team_kd-quality-hygiene'),
('team_kd-prompt', 'team_kd-quality-hygiene');

-- Insert into team_consolidations
INSERT OR IGNORE INTO team_consolidations (id, old_team_id, new_team_id, reason, evidence_json, consolidated_at)
SELECT 
  'cons_' || old_id, 
  old_id, 
  new_id, 
  '퇴사 팀 후속 조직 마이그레이션 2026-07-28', 
  '{"reason": "topology update"}', 
  datetime('now')
FROM old_to_new_mapping;

-- Update tasks metadata and set team_id = NULL
UPDATE tasks
SET 
  metadata_json = CASE 
    WHEN json_valid(metadata_json) THEN json_set(metadata_json, '$.retiredTeamId', team_id, '$.replacementTeamId', (SELECT new_id FROM old_to_new_mapping WHERE old_id = tasks.team_id))
    ELSE json_object('retiredTeamId', team_id, 'replacementTeamId', (SELECT new_id FROM old_to_new_mapping WHERE old_id = tasks.team_id))
  END,
  team_id = NULL
WHERE team_id IN (SELECT old_id FROM old_to_new_mapping);

-- Ensure work_reports and team_lifecycle_events FK is NULL for retired teams
UPDATE work_reports SET team_id = NULL WHERE team_id IN (SELECT old_id FROM old_to_new_mapping);
UPDATE team_lifecycle_events SET team_id = NULL WHERE team_id IN (SELECT old_id FROM old_to_new_mapping);

-- DELETE old teams. (team_lifecycle_profiles and team_members will CASCADE)
DELETE FROM teams WHERE id IN (SELECT old_id FROM old_to_new_mapping);

COMMIT;

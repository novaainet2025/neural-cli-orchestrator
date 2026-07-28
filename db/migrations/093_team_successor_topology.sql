-- 093: Replace retired teams with a smaller protected successor topology.
--
-- The migration runner wraps this file in an IMMEDIATE transaction with
-- foreign_keys=ON. Historical tasks are detached instead of reassigned so the
-- successor teams start with an honest, uncontaminated score sample.

CREATE TEMP TABLE IF NOT EXISTS _team_successor_map (
  old_team_id TEXT PRIMARY KEY,
  new_team_id TEXT NOT NULL
);

DELETE FROM _team_successor_map;

INSERT INTO _team_successor_map (old_team_id, new_team_id)
VALUES
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
  ('team_kd-harness', 'team_kd-quality-hygiene'),
  ('team_kd-memory', 'team_kd-quality-hygiene'),
  ('team_kd-obsidian', 'team_kd-quality-hygiene'),
  ('team_kd-prompt', 'team_kd-quality-hygiene'),
  ('team_kd-provider', 'team_kd-quality-hygiene');

-- Preserve existing active successor definitions as required capabilities.
INSERT INTO required_capabilities (
  id, organization_id, name, slug, description, color, lead, charter,
  is_always_on, protected, is_active
)
SELECT
  id, organization_id, name, slug, COALESCE(description, name),
  COALESCE(color, '#64748B'), lead, charter, is_always_on, 1, 1
FROM teams
WHERE id IN ('team_content-quality', 'team_kd-quality-hygiene')
ON CONFLICT(id) DO UPDATE SET
  organization_id=excluded.organization_id,
  name=excluded.name,
  slug=excluded.slug,
  description=excluded.description,
  color=excluded.color,
  lead=excluded.lead,
  charter=excluded.charter,
  is_always_on=excluded.is_always_on,
  protected=1,
  is_active=1;

-- Register the nine new capability owners before creating their live rows.
INSERT INTO required_capabilities (
  id, organization_id, name, slug, description, color, lead, charter,
  is_always_on, protected, is_active
)
VALUES
  (
    'team_computer-use-assurance-2026',
    'org_computer-use',
    'Computer Use 독립 안전·감사팀',
    'computer-use-safety',
    'Independently approve, reject, and audit high-risk computer-use requests without operating the controls.',
    '#DC2626',
    'cursor-agent',
    '화면·마우스·키보드를 직접 제어하지 않는다. 요청 범위, 외부 부작용, 인간 승인, 단일 제어자 잠금, 유휴 만료와 회수 증거를 독립 검토해 제어 코디네이터에게 승인·거부 의견을 전달한다. 실행팀과 분리된 사후 감사를 유지하고 복구 불가능하거나 권한이 불명확한 동작은 중단한다.',
    0, 1, 1
  ),
  (
    'team_research-strategy-2026',
    'org_research',
    '리서치 전략·방법론팀',
    'research-strategy',
    'Turn requests into bounded research questions, hypotheses, methods, evidence standards, and handoffs.',
    '#7C3AED',
    'nvidia',
    '사용자 요청을 검증 가능한 연구질문으로 분해하고 범위, 가설, 방법론, 증거등급, 성공기준과 중단조건을 정의한다. 탐색팀에 출처 요구사항을 전달하고 분석·검증팀과 독립적으로 연구 설계의 편향과 누락을 점검한다.',
    0, 1, 1
  ),
  (
    'team_cli-experience-2026',
    'org_nova-cli',
    'CLI 경험 설계팀',
    'cli-design',
    'Design accessible terminal interaction flows, information hierarchy, and operator feedback before implementation.',
    '#2563EB',
    'agy',
    'REPL 입력, Markdown 표시, diff 검토, 에이전트·세션 상태와 오류 복구 흐름을 사용자 관점에서 설계한다. 구현 전에 키보드 접근성, 정보 위계, 빈·로딩·실패 상태와 수용기준을 정의하고 코어팀에 전달한다.',
    1, 1, 1
  ),
  (
    'team_cli-assurance-2026',
    'org_nova-cli',
    'CLI 독립 검증팀',
    'cli-qa',
    'Independently verify CLI commands, provider failover, network faults, builds, and critical user journeys.',
    '#0F766E',
    'cursor-agent',
    'CLI 코어 구현팀과 독립적으로 명령·도구 호출, REST·WebSocket 연동, 타임아웃, 네트워크 장애, 프로바이더 폴백, 빌드 무결성과 핵심 사용자 흐름을 재현 검증한다. 명령 출력과 실패 증거가 없는 완료 주장은 승인하지 않는다.',
    1, 1, 1
  ),
  (
    'team_content-strategy-2026',
    'org_sns-blog',
    '콘텐츠 전략·근거기획팀',
    'content-planning',
    'Plan evidence-backed content opportunities and measurable audience outcomes before production.',
    '#DB2777',
    'agy',
    '검색의도, 독자의 구체 문제, 기존 글과의 차별점, 원문·데이터·실사례 근거 계획과 측정 가능한 독자 결과를 정의한다. 확인되지 않은 트렌드나 수치를 만들지 않고 제작팀과 품질팀에 근거 패킷을 전달한다.',
    1, 1, 1
  ),
  (
    'team_tech-port-06-decision-2026',
    'org_technology-porting',
    '06 Porting Decision Council',
    'tech-port-06-improvement-debate',
    'Independently compare direct adoption, adapters, partial ports, reimplementation, deferral, and rejection.',
    '#A855F7',
    'nvidia',
    '6단계 의사결정팀. 직접 이식, 래퍼·어댑터, 부분 포팅, 자체 재구현, 보류와 거부를 유지보수 비용, 종속성, 복잡도, 운영 위험과 장기 로드맵으로 비교한다. 구현을 직접 수행하지 않으며 반대 의견, 반례, 잔여위험과 7단계 가치 게이트 입력을 남긴다.',
    0, 1, 1
  ),
  (
    'team_tech-port-08-delivery-2026',
    'org_technology-porting',
    '08 Migration Delivery',
    'tech-port-08-migration-implementation',
    'Implement only approved migration scope with rollback-ready changes and evidence.',
    '#EA580C',
    'codex',
    '8단계 이식 구현팀. 직전 리포트에 PORT_DECISION: APPROVE가 없으면 코드·설정·DB를 변경하지 않는다. 승인 범위만 최소 변경하고 기존 사용자 변경과 비밀정보를 보존하며 테스트, 데이터 전환, 롤백 절차와 검증 영수증을 9단계 팀에 전달한다.',
    0, 1, 1
  ),
  (
    'team_ax-business-operations-2026',
    'org_nova-ax',
    'Business Operations & Revenue Intelligence',
    'ax-business-operations',
    'Unify analytics, financial stewardship, forecasting, sales operations, and revenue evidence.',
    '#059669',
    'nvidia',
    '회사 KPI, 비용·예산, 수요 예측, 영업 파이프라인과 고객·매출 신호를 하나의 근거 체계로 운영한다. 지표 정의와 분모를 명시하고 마케팅·지원·재무 데이터를 교차검증하며 근거 없는 매출 전망이나 비용 절감을 성과로 보고하지 않는다.',
    1, 1, 1
  ),
  (
    'team_ax-decision-coordination-2026',
    'org_nova-ax',
    'Decision & Coordination Office',
    'ax-decision-coordination',
    'Coordinate resources, dependencies, decisions, dissent, and accountable handoffs across NOVA AX.',
    '#4F46E5',
    'claude-code',
    'NOVA AX의 자원 배분, 의존성, 작업량, 충돌, 토론과 의사결정 기록을 통합 조정한다. 제안·반대의견·승인권자·기한·핸드오프를 명시하고 자기 결정의 최종 검증을 수행하지 않는다. 법률·윤리 판단은 Governance Officer와 AI 정부에 이관한다.',
    1, 1, 1
  )
ON CONFLICT(id) DO UPDATE SET
  organization_id=excluded.organization_id,
  name=excluded.name,
  slug=excluded.slug,
  description=excluded.description,
  color=excluded.color,
  lead=excluded.lead,
  charter=excluded.charter,
  is_always_on=excluded.is_always_on,
  protected=1,
  is_active=1;

-- Keep an auditable handoff receipt. Counts remain stable on re-execution
-- because detached task metadata and report subject_id preserve the old ID.
INSERT INTO team_consolidations (
  id, old_team_id, new_team_id, reason, evidence_json, consolidated_at
)
SELECT
  'tc_successor_2026_' || replace(m.old_team_id, 'team_', ''),
  m.old_team_id,
  m.new_team_id,
  'Retired team deleted after capability handoff',
  json_object(
    'action', 'migration_093',
    'historicalTasksDetached', (
      SELECT COUNT(*)
      FROM tasks task_history
      WHERE task_history.team_id=m.old_team_id
         OR COALESCE(
              json_extract(
                CASE
                  WHEN json_valid(task_history.metadata_json) THEN task_history.metadata_json
                  ELSE '{}'
                END,
                '$.retiredTeamId'
              ),
              ''
            )=m.old_team_id
    ),
    'historicalReportsPreserved', (
      SELECT COUNT(*)
      FROM work_reports report_history
      WHERE report_history.team_id=m.old_team_id
         OR (
           report_history.subject_kind='team'
           AND report_history.subject_id=m.old_team_id
         )
    ),
    'scoreHistoryTransferred', json('false')
  ),
  datetime('now')
FROM _team_successor_map m
WHERE 1
ON CONFLICT(old_team_id) DO UPDATE SET
  new_team_id=excluded.new_team_id,
  reason=excluded.reason,
  evidence_json=excluded.evidence_json;

-- Detach historical score samples while retaining their original owner and
-- declared successor in valid object metadata.
UPDATE tasks
SET
  metadata_json=json_set(
    CASE
      WHEN json_valid(metadata_json) AND json_type(metadata_json)='object' THEN metadata_json
      ELSE '{}'
    END,
    '$.retiredTeamId', team_id,
    '$.replacementTeamId', (
      SELECT m.new_team_id
      FROM _team_successor_map m
      WHERE m.old_team_id=tasks.team_id
    ),
    '$.teamHistoryDetachedBy', '093_team_successor_topology'
  ),
  team_id=NULL,
  updated_at=datetime('now')
WHERE team_id IN (SELECT old_team_id FROM _team_successor_map);

-- work_reports and lifecycle events use ON DELETE SET NULL. Profiles and
-- memberships use ON DELETE CASCADE. tasks were detached above because their
-- FK intentionally uses NO ACTION.
DELETE FROM teams
WHERE id IN (SELECT old_team_id FROM _team_successor_map);

-- The old rows owned the compatibility slugs, so create successors only after
-- the delete has released those UNIQUE values.
INSERT INTO teams (
  id, organization_id, name, slug, description, color, lead, charter,
  is_always_on, is_active, updated_at
)
SELECT
  id, organization_id, name, slug, description, color, lead, charter,
  is_always_on, 1, datetime('now')
FROM required_capabilities
WHERE id IN (
  'team_computer-use-assurance-2026',
  'team_research-strategy-2026',
  'team_cli-experience-2026',
  'team_cli-assurance-2026',
  'team_content-strategy-2026',
  'team_tech-port-06-decision-2026',
  'team_tech-port-08-delivery-2026',
  'team_ax-business-operations-2026',
  'team_ax-decision-coordination-2026'
)
ON CONFLICT(id) DO UPDATE SET
  organization_id=excluded.organization_id,
  name=excluded.name,
  slug=excluded.slug,
  description=excluded.description,
  color=excluded.color,
  lead=excluded.lead,
  charter=excluded.charter,
  is_always_on=excluded.is_always_on,
  is_active=1,
  updated_at=datetime('now');

UPDATE teams
SET is_active=1, updated_at=datetime('now')
WHERE id IN ('team_content-quality', 'team_kd-quality-hygiene');

INSERT INTO team_members (id, team_id, member_type, member_ref)
VALUES
  ('member_computer_use_assurance_cursor_2026', 'team_computer-use-assurance-2026', 'provider', 'cursor-agent'),
  ('member_computer_use_assurance_nvidia_2026', 'team_computer-use-assurance-2026', 'provider', 'nvidia'),
  ('member_computer_use_assurance_ollama_2026', 'team_computer-use-assurance-2026', 'provider', 'ollama'),
  ('member_research_strategy_nvidia_2026', 'team_research-strategy-2026', 'provider', 'nvidia'),
  ('member_research_strategy_agy_2026', 'team_research-strategy-2026', 'provider', 'agy'),
  ('member_research_strategy_ollama_2026', 'team_research-strategy-2026', 'provider', 'ollama'),
  ('member_cli_experience_agy_2026', 'team_cli-experience-2026', 'provider', 'agy'),
  ('member_cli_experience_claude_2026', 'team_cli-experience-2026', 'provider', 'claude-code'),
  ('member_cli_experience_cursor_2026', 'team_cli-experience-2026', 'provider', 'cursor-agent'),
  ('member_cli_assurance_cursor_2026', 'team_cli-assurance-2026', 'provider', 'cursor-agent'),
  ('member_cli_assurance_nvidia_2026', 'team_cli-assurance-2026', 'provider', 'nvidia'),
  ('member_cli_assurance_ollama_2026', 'team_cli-assurance-2026', 'provider', 'ollama'),
  ('member_content_strategy_agy_2026', 'team_content-strategy-2026', 'provider', 'agy'),
  ('member_content_strategy_nvidia_2026', 'team_content-strategy-2026', 'provider', 'nvidia'),
  ('member_content_strategy_ollama_2026', 'team_content-strategy-2026', 'provider', 'ollama'),
  ('member_port_decision_nvidia_2026', 'team_tech-port-06-decision-2026', 'provider', 'nvidia'),
  ('member_port_decision_agy_2026', 'team_tech-port-06-decision-2026', 'provider', 'agy'),
  ('member_port_decision_claude_2026', 'team_tech-port-06-decision-2026', 'provider', 'claude-code'),
  ('member_port_delivery_codex_2026', 'team_tech-port-08-delivery-2026', 'provider', 'codex'),
  ('member_port_delivery_cursor_2026', 'team_tech-port-08-delivery-2026', 'provider', 'cursor-agent'),
  ('member_port_delivery_opencode_2026', 'team_tech-port-08-delivery-2026', 'provider', 'opencode'),
  ('member_business_ops_nvidia_2026', 'team_ax-business-operations-2026', 'provider', 'nvidia'),
  ('member_business_ops_agy_2026', 'team_ax-business-operations-2026', 'provider', 'agy'),
  ('member_business_ops_ollama_2026', 'team_ax-business-operations-2026', 'provider', 'ollama'),
  ('member_decision_coord_claude_2026', 'team_ax-decision-coordination-2026', 'provider', 'claude-code'),
  ('member_decision_coord_cursor_2026', 'team_ax-decision-coordination-2026', 'provider', 'cursor-agent'),
  ('member_decision_coord_hermes_2026', 'team_ax-decision-coordination-2026', 'provider', 'hermes')
ON CONFLICT(team_id, member_type, member_ref) DO NOTHING;

INSERT OR IGNORE INTO team_lifecycle_profiles (
  team_id, status, protected,
  improvement_count, successful_improvement_count, failed_improvement_count,
  unresolved_improvement_count, consecutive_low_checks,
  last_score, last_sample_size,
  first_low_at, last_checked_at, last_improvement_at, active_run_id,
  retired_at, retirement_reason,
  updated_at
)
SELECT
  id, 'active', 1,
  0, 0, 0,
  0, 0,
  NULL, 0,
  NULL, NULL, NULL, NULL,
  NULL, NULL,
  datetime('now')
FROM required_capabilities
WHERE id IN (
  'team_computer-use-assurance-2026',
  'team_research-strategy-2026',
  'team_cli-experience-2026',
  'team_cli-assurance-2026',
  'team_content-strategy-2026',
  'team_tech-port-06-decision-2026',
  'team_tech-port-08-delivery-2026',
  'team_ax-business-operations-2026',
  'team_ax-decision-coordination-2026',
  'team_content-quality',
  'team_kd-quality-hygiene'
);

UPDATE team_lifecycle_profiles
SET
  status='active',
  protected=1,
  retired_at=NULL,
  retirement_reason=NULL,
  updated_at=datetime('now')
WHERE team_id IN (
  'team_computer-use-assurance-2026',
  'team_research-strategy-2026',
  'team_cli-experience-2026',
  'team_cli-assurance-2026',
  'team_content-strategy-2026',
  'team_tech-port-06-decision-2026',
  'team_tech-port-08-delivery-2026',
  'team_ax-business-operations-2026',
  'team_ax-decision-coordination-2026',
  'team_content-quality',
  'team_kd-quality-hygiene'
);

DROP TABLE _team_successor_map;

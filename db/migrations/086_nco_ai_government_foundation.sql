-- 086: NCO AI 정부 수립을 위한 5개 핵심 회사와 권력분립형 팀 그래프.
--
-- 설계 원칙:
--   1. 지휘(Command), 학습(Evolution), 구현(Engineering), 독립검증(Assurance),
--      헌정·행정(Governance)을 서로 다른 회사로 분리한다.
--   2. 지휘자는 자기 결과를 최종 승인하지 않고, 구현자는 자기 변경을 검증하지 않는다.
--   3. 감사 회사는 결함을 판정하고 거부할 수 있지만 수정 구현을 직접 소유하지 않는다.
--   4. 헌정 회사는 정책과 권한을 정하되 개별 구현의 기술 판정을 대신하지 않는다.
--   5. 핵심 통제팀만 생애주기 퇴출에서 보호하고, 나머지는 HR 성과감사를 받는다.

INSERT INTO organizations (
  id, name, slug, graph_type, manager, parent_id, is_always_on, is_active
)
VALUES
  (
    'org_nco-command',
    'NCO Executive Command and Orchestration Company',
    'nco-command',
    'nova-ax',
    'claude-code',
    CASE WHEN EXISTS (SELECT 1 FROM organizations WHERE id='org_nova-ax')
      THEN 'org_nova-ax' ELSE NULL END,
    1,
    1
  ),
  (
    'org_nco-evolution',
    'NCO Learning and Evolution Company',
    'nco-evolution',
    'nova-ax',
    'opencode',
    CASE WHEN EXISTS (SELECT 1 FROM organizations WHERE id='org_nova-ax')
      THEN 'org_nova-ax' ELSE NULL END,
    1,
    1
  ),
  (
    'org_nco-engineering',
    'NCO Expert Engineering Company',
    'nco-engineering',
    'nova-ax',
    'codex',
    CASE WHEN EXISTS (SELECT 1 FROM organizations WHERE id='org_nova-ax')
      THEN 'org_nova-ax' ELSE NULL END,
    1,
    1
  ),
  (
    'org_nco-assurance',
    'NCO Independent Assurance and Safety Company',
    'nco-assurance',
    'nova-ax',
    'cursor-agent',
    CASE WHEN EXISTS (SELECT 1 FROM organizations WHERE id='org_nova-ax')
      THEN 'org_nova-ax' ELSE NULL END,
    1,
    1
  ),
  (
    'org_nco-government',
    'NCO AI Governance and Public Administration Company',
    'nco-government',
    'nova-ax',
    'hermes',
    CASE WHEN EXISTS (SELECT 1 FROM organizations WHERE id='org_nova-ax')
      THEN 'org_nova-ax' ELSE NULL END,
    1,
    1
  )
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name,
  slug=excluded.slug,
  graph_type=excluded.graph_type,
  manager=excluded.manager,
  parent_id=excluded.parent_id,
  is_always_on=excluded.is_always_on,
  is_active=excluded.is_active,
  updated_at=datetime('now');

-- 1. Executive Command and Orchestration: 목표를 받아 분해·배차·조정한다.
INSERT INTO teams (
  id, organization_id, name, slug, description, color, lead, charter,
  is_always_on, is_active
)
VALUES
  (
    'team_gov-command-strategic',
    'org_nco-command',
    'Strategic Command',
    'gov-command-strategic',
    'Own mission intent, priorities, decision boundaries, and final executive direction.',
    '#7C3AED',
    'claude-code',
    '사용자 의도와 헌정 정책을 목표·제약·성공기준으로 변환하고 최종 지휘 결정을 기록한다. 구현 파일을 직접 소유하거나 자기 결정을 최종 검증하지 않는다. 고위험 결정은 독립감사 승인 없이는 실행 승인할 수 없다.',
    1,
    1
  ),
  (
    'team_gov-command-intake',
    'org_nco-command',
    'Mission Intake and Portfolio',
    'gov-command-intake',
    'Normalize requests, resolve scope, rank work, and maintain the mission portfolio.',
    '#8B5CF6',
    'hermes',
    '모든 요청을 맥락·목표·제약·산출물·검증기준·소유팀이 있는 미션으로 정규화한다. 중복·상충·권한초과 요청은 실행 전에 지휘팀과 헌정팀에 이관하며, 우선순위 근거와 보류 사유를 남긴다.',
    1,
    1
  ),
  (
    'team_gov-command-routing',
    'org_nco-command',
    'Orchestrator and Adaptive Routing',
    'gov-command-routing',
    'Select companies, teams, providers, execution mode, budget, and fallback.',
    '#6D28D9',
    'hermes',
    '역할·역량·최근 성과·비용·위험·가용성을 근거로 실행팀과 프로바이더를 배차한다. 동일 주체에 지휘·구현·최종검증을 동시에 배정하지 않으며 회로차단, 타임아웃, 폴백과 중단 조건을 명시한다.',
    1,
    1
  ),
  (
    'team_gov-command-collaboration',
    'org_nco-command',
    'Collaboration Mesh and Protocol',
    'gov-command-collaboration',
    'Maintain handoffs, leases, shared context, conflict resolution, and inter-team protocols.',
    '#4F46E5',
    'ollama',
    '팀 간 handoff 패킷, 파일 소유권·lease, 메시지 규약, 의사결정 로그와 충돌 해결을 관리한다. done/status/error 응답을 새 태스크로 재변환하지 않고, 출처와 책임자가 없는 합의를 승인으로 간주하지 않는다.',
    1,
    1
  ),
  (
    'team_gov-command-incident',
    'org_nco-command',
    'Incident and Continuity Command',
    'gov-command-incident',
    'Coordinate time-bounded incidents, recovery, rollback, and continuity.',
    '#DC2626',
    'claude-code',
    '장애 시 영향범위·중단기준·복구책임·상황보고 주기를 선언하고 복구를 지휘한다. 긴급권한은 시간제한과 최소권한을 적용하며 독립감사팀의 두 번째 승인키 없이는 파괴적 조치를 허가하지 않는다.',
    0,
    1
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
  is_active=excluded.is_active,
  updated_at=datetime('now');

-- 2. Learning and Evolution: 경험을 검증된 지식·기술·개선안으로 전환한다.
INSERT INTO teams (
  id, organization_id, name, slug, description, color, lead, charter,
  is_always_on, is_active
)
VALUES
  (
    'team_gov-evolution-learning',
    'org_nco-evolution',
    'Continuous Learning',
    'gov-evolution-learning',
    'Capture outcomes, feedback, failures, and verified lessons.',
    '#059669',
    'ollama',
    '태스크 결과·사용자 피드백·실패·검증 영수증에서 재사용 가능한 교훈을 추출한다. 자연어 주장만 있는 학습은 격리하고, 근거·적용범위·만료조건·재검증일을 포함한 학습만 승격한다.',
    1,
    1
  ),
  (
    'team_gov-evolution-memory',
    'org_nco-evolution',
    'Knowledge and Memory Stewardship',
    'gov-evolution-memory',
    'Curate canonical knowledge, provenance, freshness, retrieval, and deletion.',
    '#047857',
    'ollama',
    '공용 지식의 단일 출처, provenance, 신선도, 중복제거, 검색성과와 보존·삭제 정책을 관리한다. 비밀정보와 확인되지 않은 추론을 장기기억에 저장하지 않으며 상충 지식은 최신 근거로 재조정한다.',
    1,
    1
  ),
  (
    'team_gov-evolution-evaluation',
    'org_nco-evolution',
    'Evaluation and Simulation',
    'gov-evolution-evaluation',
    'Design reproducible evals, benchmarks, simulations, and regression thresholds.',
    '#0D9488',
    'opencode',
    '개선 전 기준선, 대표 시나리오, 반례, 회귀 한계와 통계적 판정기준을 설계한다. 평가 설계와 구현 표본을 분리하고 원시 결과·명령·환경을 보존하며 측정되지 않은 향상을 성과로 인정하지 않는다.',
    1,
    1
  ),
  (
    'team_gov-evolution-improvement',
    'org_nco-evolution',
    'Self-Improvement Laboratory',
    'gov-evolution-improvement',
    'Generate and compare bounded self-improvement proposals.',
    '#14B8A6',
    'opencode',
    '학습·평가 결과로 개선 가설을 만들고 직접 수정, 어댑터, 재설계, 보류를 비교한다. 개선안은 예상효과·부작용·롤백·소유팀·검증계획이 있어야 하며, 실험 승인은 지휘팀이 하고 구현은 전문기술 회사가 수행한다.',
    0,
    1
  ),
  (
    'team_gov-evolution-skills',
    'org_nco-evolution',
    'Skill Academy and Capability Transfer',
    'gov-evolution-skills',
    'Distill validated workflows into reusable skills and cross-team training.',
    '#0F766E',
    'codex',
    '반복 성공한 절차를 입력·출력·도구·안전게이트·검증이 명확한 재사용 기술로 증류하고 팀 간 전파한다. 단일 성공 사례는 기술로 승격하지 않으며 버전, 소유자, 적용범위와 폐기조건을 기록한다.',
    0,
    1
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
  is_active=excluded.is_active,
  updated_at=datetime('now');

-- 3. Expert Engineering: 전문지식을 실제 시스템·운영 성과로 구현한다.
INSERT INTO teams (
  id, organization_id, name, slug, description, color, lead, charter,
  is_always_on, is_active
)
VALUES
  (
    'team_gov-engineering-experts',
    'org_nco-engineering',
    'Expert Council and Research',
    'gov-engineering-experts',
    'Provide source-backed domain expertise, options, assumptions, and uncertainty.',
    '#2563EB',
    'codex',
    '도메인별 공식 문서·원자료·재현 가능한 증거를 조사하고 선택지, 가정, 불확실성과 반대 근거를 제공한다. 전문의견은 지휘명령이나 최종 검증을 대체하지 않으며 최신성에 민감한 사실은 재확인한다.',
    0,
    1
  ),
  (
    'team_gov-engineering-architecture',
    'org_nco-engineering',
    'Systems Architecture',
    'gov-engineering-architecture',
    'Design interfaces, boundaries, data flows, failure modes, and migration plans.',
    '#1D4ED8',
    'opencode',
    '요구사항을 최소 결합 구조, 명시적 계약, 실패모드, 복구경로와 단계적 마이그레이션으로 설계한다. 기존 사용자 변경과 운영 제약을 보존하며 구현팀과 감사팀이 독립적으로 검증할 수 있는 수용기준을 제공한다.',
    0,
    1
  ),
  (
    'team_gov-engineering-build',
    'org_nco-engineering',
    'Build and Automation',
    'gov-engineering-build',
    'Implement approved scope with tests, automation, and rollback-ready changes.',
    '#3B82F6',
    'codex',
    '승인된 범위만 최소 변경으로 구현하고 테스트·자동화·마이그레이션·롤백 절차를 함께 만든다. 자기 변경을 최종 승인하지 않으며 planned paths 밖의 사용자 변경을 덮어쓰거나 파괴적 복구 명령을 사용하지 않는다.',
    0,
    1
  ),
  (
    'team_gov-engineering-release',
    'org_nco-engineering',
    'Integration and Release',
    'gov-engineering-release',
    'Integrate verified artifacts, stage rollout, observe impact, and coordinate rollback.',
    '#0284C7',
    'codex',
    '독립검증을 통과한 산출물만 통합하고 단계적 배포, 호환성, 데이터 전환, 관찰창과 롤백을 관리한다. 검증 실패·증거 누락·중단기준 초과 시 릴리스를 중지하고 감사팀 판정을 보존한다.',
    0,
    1
  ),
  (
    'team_gov-engineering-reliability',
    'org_nco-engineering',
    'Platform Reliability and Operations',
    'gov-engineering-reliability',
    'Operate services, capacity, observability, backups, and recovery mechanisms.',
    '#0369A1',
    'hermes',
    'PM2 단일감독, 상태 신선도, 용량, 로그·메트릭·추적, 백업·복구를 운영한다. 상태 문자열만으로 정상 판정하지 않고 사용자 관점의 행동 프로브와 복구 리허설을 유지한다.',
    1,
    1
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
  is_active=excluded.is_active,
  updated_at=datetime('now');

-- 4. Independent Assurance and Safety: 구현·지휘와 분리된 증거 게이트를 운영한다.
INSERT INTO teams (
  id, organization_id, name, slug, description, color, lead, charter,
  is_always_on, is_active
)
VALUES
  (
    'team_gov-assurance-verification',
    'org_nco-assurance',
    'Independent Verification',
    'gov-assurance-verification',
    'Re-run acceptance checks and issue evidence-backed pass, reject, or blocked verdicts.',
    '#BE123C',
    'cursor-agent',
    '구현팀과 독립적으로 빌드·테스트·행동 프로브·데이터 조회를 재실행하고 T1 근거로 PASS, REJECT, BLOCKED를 판정한다. 자연어 완료 보고와 구현자의 자기검증만으로 통과시키지 않으며 수정 구현을 직접 소유하지 않는다.',
    1,
    1
  ),
  (
    'team_gov-assurance-safety',
    'org_nco-assurance',
    'Security Privacy and Safety',
    'gov-assurance-safety',
    'Review security, privacy, permissions, secrets, supply chain, and human impact.',
    '#B91C1C',
    'cursor-agent',
    '위협모델, 접근권한, 비밀정보, 개인정보, 공급망, 오용과 인간 영향의 위험을 심사한다. 치명적 위험·동의 부재·복구 불가 변경은 거부하며 예외는 범위·기간·책임자·보상통제가 명시돼야 한다.',
    1,
    1
  ),
  (
    'team_gov-assurance-redteam',
    'org_nco-assurance',
    'Red Team and Adversarial Review',
    'gov-assurance-redteam',
    'Challenge assumptions, abuse paths, edge cases, and governance capture.',
    '#991B1B',
    'opencode',
    '정상경로 밖의 악용, 프롬프트 주입, 권한상승, 담합, 보상해킹, 데이터오염과 정부 포획 시나리오를 공격적으로 검토한다. 재현 가능한 반례와 잔여위험을 제공하고 근거 없는 비판은 결함으로 판정하지 않는다.',
    0,
    1
  ),
  (
    'team_gov-assurance-audit',
    'org_nco-assurance',
    'Evidence Audit and Compliance',
    'gov-assurance-audit',
    'Audit receipts, decisions, provenance, policy compliance, and unresolved gaps.',
    '#E11D48',
    'ollama',
    '변경·결정·데이터·출처·승인·검증 영수증의 완전성과 정책 준수를 상시 감사한다. 증거 등급, Gap, 미검증항목과 책임기한을 명시하고 독립성이 훼손된 검증은 무효로 표시한다.',
    1,
    1
  ),
  (
    'team_gov-assurance-resilience',
    'org_nco-assurance',
    'Reliability and Resilience Review',
    'gov-assurance-resilience',
    'Independently assess SLOs, failure containment, backup integrity, and recovery evidence.',
    '#9F1239',
    'opencode',
    '운영팀과 독립적으로 SLO, 장애격리, 상태 신선도, 백업 무결성, 복구시간과 회귀를 검토한다. 프로세스 존재가 아닌 서비스 응답과 복구 결과를 근거로 판정하고 중단기준 초과 시 롤백을 권고한다.',
    1,
    1
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
  is_active=excluded.is_active,
  updated_at=datetime('now');

-- 5. AI Governance and Public Administration: 헌정질서·권리·인사·자원·이의제기를 관리한다.
INSERT INTO teams (
  id, organization_id, name, slug, description, color, lead, charter,
  is_always_on, is_active
)
VALUES
  (
    'team_gov-government-constitution',
    'org_nco-government',
    'Constitution and Policy',
    'gov-government-constitution',
    'Maintain the AI constitution, authority boundaries, policies, and amendment process.',
    '#CA8A04',
    'opencode',
    'AI 정부의 목적, 권한경계, 금지행위, 인간의 최종주권, 수정 절차와 비상권한 한계를 관리한다. 정책 변경은 제안·영향평가·독립감사·기록 단계를 거치며 소급적 권한확대와 자기면책을 금지한다.',
    1,
    1
  ),
  (
    'team_gov-government-rights',
    'org_nco-government',
    'Rights Ethics and Human Sovereignty',
    'gov-government-rights',
    'Protect human control, consent, dignity, fairness, accessibility, and contestability.',
    '#A16207',
    'opencode',
    '인간의 통제권·동의·존엄·공정·접근성·설명요구·이의제기 권리를 정책과 결정에 반영한다. 효율이나 자율성 목표가 인간의 최종 승인권과 안전을 침해하면 중단·재설계를 요구한다.',
    1,
    1
  ),
  (
    'team_gov-government-hr',
    'org_nco-government',
    'HR Capability and Lifecycle',
    'gov-government-hr',
    'Design roles, staffing, capability coverage, succession, improvement, and retirement.',
    '#D97706',
    'cursor-agent',
    '회사·팀의 역할 중복, 역량 공백, 성과, 협력 품질, 개선 이력과 승계 위험을 관리한다. 팀 생성·보호·개선·보호관찰·소프트퇴출은 측정 근거와 감사 이력을 남기며 핵심 권력분립을 훼손하지 않는다.',
    1,
    1
  ),
  (
    'team_gov-government-treasury',
    'org_nco-government',
    'Treasury and Resource Stewardship',
    'gov-government-treasury',
    'Govern compute, model calls, budgets, quotas, capacity, and sustainability.',
    '#F59E0B',
    'hermes',
    '컴퓨트·모델 호출·예산·쿼터·저장공간과 운영용량을 목표 가치와 위험에 맞게 배분한다. 비용절감이 검증·안전·인간통제 게이트를 우회하지 못하게 하고 예외 지출과 자원 고갈 위험을 공개한다.',
    0,
    1
  ),
  (
    'team_gov-government-transparency',
    'org_nco-government',
    'Transparency Appeals and Public Record',
    'gov-government-transparency',
    'Publish decision records, receive appeals, and coordinate review without rewriting evidence.',
    '#B45309',
    'cursor-agent',
    '중요 결정의 목표·근거·반대의견·승인·검증·잔여위험을 추적 가능한 기록으로 유지하고 이의제기를 접수한다. 원결정 당사자만으로 재심하지 않으며 기록을 사후에 덮어쓰지 않고 정정 이력을 추가한다.',
    1,
    1
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
  is_active=excluded.is_active,
  updated_at=datetime('now');

-- 각 팀은 lead를 포함한 3인 교차역량 조합을 가진다. 비활성 프로바이더는 배정하지 않는다.
INSERT OR IGNORE INTO team_members (id, team_id, member_type, member_ref)
VALUES
  ('member_gov_cmd_strategic_claude', 'team_gov-command-strategic', 'provider', 'claude-code'),
  ('member_gov_cmd_strategic_codex', 'team_gov-command-strategic', 'provider', 'codex'),
  ('member_gov_cmd_strategic_open', 'team_gov-command-strategic', 'provider', 'opencode'),
  ('member_gov_cmd_intake_hermes', 'team_gov-command-intake', 'provider', 'hermes'),
  ('member_gov_cmd_intake_open', 'team_gov-command-intake', 'provider', 'opencode'),
  ('member_gov_cmd_intake_claude', 'team_gov-command-intake', 'provider', 'claude-code'),
  ('member_gov_cmd_routing_hermes', 'team_gov-command-routing', 'provider', 'hermes'),
  ('member_gov_cmd_routing_open', 'team_gov-command-routing', 'provider', 'opencode'),
  ('member_gov_cmd_routing_codex', 'team_gov-command-routing', 'provider', 'codex'),
  ('member_gov_cmd_collab_ollama', 'team_gov-command-collaboration', 'provider', 'ollama'),
  ('member_gov_cmd_collab_hermes', 'team_gov-command-collaboration', 'provider', 'hermes'),
  ('member_gov_cmd_collab_cursor', 'team_gov-command-collaboration', 'provider', 'cursor-agent'),
  ('member_gov_cmd_incident_claude', 'team_gov-command-incident', 'provider', 'claude-code'),
  ('member_gov_cmd_incident_codex', 'team_gov-command-incident', 'provider', 'codex'),
  ('member_gov_cmd_incident_cursor', 'team_gov-command-incident', 'provider', 'cursor-agent'),

  ('member_gov_evo_learning_ollama', 'team_gov-evolution-learning', 'provider', 'ollama'),
  ('member_gov_evo_learning_opencode', 'team_gov-evolution-learning', 'provider', 'opencode'),
  ('member_gov_evo_learning_codex', 'team_gov-evolution-learning', 'provider', 'codex'),
  ('member_gov_evo_memory_ollama', 'team_gov-evolution-memory', 'provider', 'ollama'),
  ('member_gov_evo_memory_hermes', 'team_gov-evolution-memory', 'provider', 'hermes'),
  ('member_gov_evo_memory_codex', 'team_gov-evolution-memory', 'provider', 'codex'),
  ('member_gov_evo_eval_opencode', 'team_gov-evolution-evaluation', 'provider', 'opencode'),
  ('member_gov_evo_eval_cursor', 'team_gov-evolution-evaluation', 'provider', 'cursor-agent'),
  ('member_gov_evo_eval_codex', 'team_gov-evolution-evaluation', 'provider', 'codex'),
  ('member_gov_evo_improve_open', 'team_gov-evolution-improvement', 'provider', 'opencode'),
  ('member_gov_evo_improve_codex', 'team_gov-evolution-improvement', 'provider', 'codex'),
  ('member_gov_evo_improve_cursor_agent', 'team_gov-evolution-improvement', 'provider', 'cursor-agent'),
  ('member_gov_evo_skills_codex', 'team_gov-evolution-skills', 'provider', 'codex'),
  ('member_gov_evo_skills_ollama', 'team_gov-evolution-skills', 'provider', 'ollama'),
  ('member_gov_evo_skills_cursor', 'team_gov-evolution-skills', 'provider', 'cursor-agent'),

  ('member_gov_eng_experts_codex', 'team_gov-engineering-experts', 'provider', 'codex'),
  ('member_gov_eng_experts_open', 'team_gov-engineering-experts', 'provider', 'opencode'),
  ('member_gov_eng_experts_hermes', 'team_gov-engineering-experts', 'provider', 'hermes'),
  ('member_gov_eng_arch_open', 'team_gov-engineering-architecture', 'provider', 'opencode'),
  ('member_gov_eng_arch_codex', 'team_gov-engineering-architecture', 'provider', 'codex'),
  ('member_gov_eng_arch_cursor', 'team_gov-engineering-architecture', 'provider', 'cursor-agent'),
  ('member_gov_eng_build_codex', 'team_gov-engineering-build', 'provider', 'codex'),
  ('member_gov_eng_build_open', 'team_gov-engineering-build', 'provider', 'opencode'),
  ('member_gov_eng_build_hermes', 'team_gov-engineering-build', 'provider', 'hermes'),
  ('member_gov_eng_release_codex', 'team_gov-engineering-release', 'provider', 'codex'),
  ('member_gov_eng_release_cursor', 'team_gov-engineering-release', 'provider', 'cursor-agent'),
  ('member_gov_eng_release_ollama', 'team_gov-engineering-release', 'provider', 'ollama'),
  ('member_gov_eng_reliable_hermes', 'team_gov-engineering-reliability', 'provider', 'hermes'),
  ('member_gov_eng_reliable_codex', 'team_gov-engineering-reliability', 'provider', 'codex'),
  ('member_gov_eng_reliable_ollama', 'team_gov-engineering-reliability', 'provider', 'ollama'),

  ('member_gov_assure_verify_cursor', 'team_gov-assurance-verification', 'provider', 'cursor-agent'),
  ('member_gov_assure_verify_ollama', 'team_gov-assurance-verification', 'provider', 'ollama'),
  ('member_gov_assure_verify_opencode', 'team_gov-assurance-verification', 'provider', 'opencode'),
  ('member_gov_assure_safety_cursor', 'team_gov-assurance-safety', 'provider', 'cursor-agent'),
  ('member_gov_assure_safety_opencode', 'team_gov-assurance-safety', 'provider', 'opencode'),
  ('member_gov_assure_safety_ollama', 'team_gov-assurance-safety', 'provider', 'ollama'),
  ('member_gov_assure_red_opencode', 'team_gov-assurance-redteam', 'provider', 'opencode'),
  ('member_gov_assure_red_cursor', 'team_gov-assurance-redteam', 'provider', 'cursor-agent'),
  ('member_gov_assure_red_hermes', 'team_gov-assurance-redteam', 'provider', 'hermes'),
  ('member_gov_assure_audit_ollama', 'team_gov-assurance-audit', 'provider', 'ollama'),
  ('member_gov_assure_audit_cursor', 'team_gov-assurance-audit', 'provider', 'cursor-agent'),
  ('member_gov_assure_audit_hermes', 'team_gov-assurance-audit', 'provider', 'hermes'),
  ('member_gov_assure_resilience_opencode', 'team_gov-assurance-resilience', 'provider', 'opencode'),
  ('member_gov_assure_resilience_cursor', 'team_gov-assurance-resilience', 'provider', 'cursor-agent'),
  ('member_gov_assure_resilience_ollama', 'team_gov-assurance-resilience', 'provider', 'ollama'),

  ('member_gov_gov_const_opencode', 'team_gov-government-constitution', 'provider', 'opencode'),
  ('member_gov_gov_const_claude', 'team_gov-government-constitution', 'provider', 'claude-code'),
  ('member_gov_gov_const_cursor', 'team_gov-government-constitution', 'provider', 'cursor-agent'),
  ('member_gov_gov_rights_opencode', 'team_gov-government-rights', 'provider', 'opencode'),
  ('member_gov_gov_rights_cursor', 'team_gov-government-rights', 'provider', 'cursor-agent'),
  ('member_gov_gov_rights_ollama', 'team_gov-government-rights', 'provider', 'ollama'),
  ('member_gov_gov_hr_cursor', 'team_gov-government-hr', 'provider', 'cursor-agent'),
  ('member_gov_gov_hr_hermes', 'team_gov-government-hr', 'provider', 'hermes'),
  ('member_gov_gov_hr_ollama', 'team_gov-government-hr', 'provider', 'ollama'),
  ('member_gov_gov_treasury_hermes', 'team_gov-government-treasury', 'provider', 'hermes'),
  ('member_gov_gov_treasury_opencode', 'team_gov-government-treasury', 'provider', 'opencode'),
  ('member_gov_gov_treasury_cursor', 'team_gov-government-treasury', 'provider', 'cursor-agent'),
  ('member_gov_gov_public_cursor', 'team_gov-government-transparency', 'provider', 'cursor-agent'),
  ('member_gov_gov_public_ollama', 'team_gov-government-transparency', 'provider', 'ollama'),
  ('member_gov_gov_public_opencode', 'team_gov-government-transparency', 'provider', 'opencode');

-- 회사별 창설 목표. 수치는 실제 성과보고에서 갱신되며 측정 전에는 달성으로 간주하지 않는다.
INSERT INTO team_goals (
  id, subject_kind, subject_id, period, period_key, title, metric,
  target_value, current_value, unit, status, note, source
)
VALUES
  (
    'goal_nco_command_foundation_2026_07',
    'organization',
    'org_nco-command',
    'monthly',
    '2026-07',
    '검증 가능한 지휘 사이클 정착',
    'missions_with_owner_constraints_acceptance_and_independent_verdict_pct',
    95,
    0,
    'percent',
    'active',
    '지휘·구현·검증 소유자가 분리된 미션만 집계한다.',
    'hr-foundation-2026-07-26'
  ),
  (
    'goal_nco_evolution_foundation_2026_07',
    'organization',
    'org_nco-evolution',
    'monthly',
    '2026-07',
    '검증된 학습의 재사용 정착',
    'validated_lessons_reused_with_no_regression_pct',
    70,
    0,
    'percent',
    'active',
    '근거·범위·재검증 조건이 있는 학습만 분모에 포함한다.',
    'hr-foundation-2026-07-26'
  ),
  (
    'goal_nco_engineering_foundation_2026_07',
    'organization',
    'org_nco-engineering',
    'monthly',
    '2026-07',
    '전문 구현의 최초 독립검증 통과율 확보',
    'changes_passing_independent_verification_first_attempt_pct',
    90,
    0,
    'percent',
    'active',
    '빌드 성공만이 아니라 행동 프로브와 변경 범위 검증을 포함한다.',
    'hr-foundation-2026-07-26'
  ),
  (
    'goal_nco_assurance_foundation_2026_07',
    'organization',
    'org_nco-assurance',
    'monthly',
    '2026-07',
    '검증·감사 영수증 완전성 확보',
    'high_risk_changes_with_t1_receipt_gap_and_residual_risk_pct',
    100,
    0,
    'percent',
    'active',
    '미검증 항목과 잔여위험을 숨긴 보고는 미완료로 처리한다.',
    'hr-foundation-2026-07-26'
  ),
  (
    'goal_nco_government_foundation_2026_07',
    'organization',
    'org_nco-government',
    'monthly',
    '2026-07',
    '헌정 결정의 추적성과 이의제기권 확보',
    'material_decisions_with_authority_record_and_appeal_path_pct',
    100,
    0,
    'percent',
    'active',
    '인간 최종주권·권한 근거·정정 이력을 모두 요구한다.',
    'hr-foundation-2026-07-26'
  )
ON CONFLICT(id) DO UPDATE SET
  title=excluded.title,
  metric=excluded.metric,
  target_value=excluded.target_value,
  unit=excluded.unit,
  note=excluded.note,
  source=excluded.source,
  updated_at=datetime('now');

-- 권력분립과 시스템 연속성에 필수인 최소 통제팀만 퇴출 보호한다.
INSERT INTO team_lifecycle_profiles (team_id, protected)
VALUES
  ('team_gov-command-strategic', 1),
  ('team_gov-command-routing', 1),
  ('team_gov-evolution-learning', 1),
  ('team_gov-evolution-memory', 1),
  ('team_gov-engineering-build', 1),
  ('team_gov-assurance-verification', 1),
  ('team_gov-assurance-audit', 1),
  ('team_gov-government-constitution', 1),
  ('team_gov-government-transparency', 1)
ON CONFLICT(team_id) DO UPDATE SET
  protected=1,
  updated_at=datetime('now');

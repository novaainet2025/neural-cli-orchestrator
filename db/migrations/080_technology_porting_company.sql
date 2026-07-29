-- 080: 기술 이식 회사를 재현 가능한 조직 그래프로 등록한다.
-- 과거 로컬 DB에만 존재하던 9단계 안전 게이트를 새 설치에서도 보장한다.

INSERT INTO organizations (
  id, name, slug, graph_type, manager, is_always_on, is_active
)
VALUES (
  'org_technology-porting',
  'Technology Porting Company',
  'technology-porting',
  'nova-ax',
  'codex',
  0,
  1
)
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name,
  manager=excluded.manager,
  is_always_on=0,
  is_active=1,
  updated_at=datetime('now');

INSERT INTO teams (
  id, organization_id, name, slug, description, color, lead, charter,
  is_always_on, is_active
)
VALUES
  (
    'team_tech-port-01-source-discovery',
    'org_technology-porting',
    '01 Source Discovery',
    'tech-port-01-source-discovery',
    'Collect primary-source technology, version, provenance, and reproducible evidence.',
    '#2563EB',
    'cursor-agent',
    '1단계 기술 탐색·습득. 공식 저장소, 릴리스/보안 공지, 라이선스, 논문 원문, 재현 가능한 벤치마크를 우선한다. 후보 기술의 버전·commit SHA·출처 URL·검증일·대안을 기록하며 출처 불명 코드나 재현 불가 수치는 채택 근거로 사용하지 않는다.',
    0,
    1
  ),
  (
    'team_tech-port-02-safety-license',
    'org_technology-porting',
    '02 Safety and License',
    'tech-port-02-safety-license',
    'Review license, supply-chain, permissions, secrets, privacy, and residual risk.',
    '#DC2626',
    'codex',
    '2단계 안전 심사. 의존성/SBOM, 설치 스크립트, 네트워크·파일 권한, 비밀정보 노출, 라이선스 호환성, 유지보수 상태와 공급망 위험을 검토한다. 치명적 위험 또는 라이선스 불명확 시 즉시 STOP을 권고한다.',
    0,
    1
  ),
  (
    'team_tech-port-03-recovery-checkpoint',
    'org_technology-porting',
    '03 Recovery Checkpoint',
    'tech-port-03-recovery-checkpoint',
    'Preserve user work and prove a recovery path before changing code or data.',
    '#F59E0B',
    'opencode',
    '3단계 복구 지점 생성. dirty worktree와 사용자 변경을 먼저 식별해 보존하고, 기준 commit SHA, 설정 백업, DB 역마이그레이션, 롤백 명령과 검증 체크리스트를 만든다. destructive reset·checkout·대량삭제는 금지한다.',
    0,
    1
  ),
  (
    'team_tech-port-04-baseline-benchmark',
    'org_technology-porting',
    '04 Baseline Benchmark',
    'tech-port-04-baseline-benchmark',
    'Measure a reproducible baseline and define regression limits.',
    '#0891B2',
    'opencode',
    '4단계 기준선 측정. 기존 테스트, 대표 사용자 시나리오, 지연, 처리량, 자원, 오류율, 성공률과 회귀 민감 지표를 동일 조건에서 측정하고 원시 결과와 실행 명령을 보존한다.',
    0,
    1
  ),
  (
    'team_tech-port-05-upgrade-regression',
    'org_technology-porting',
    '05 Upgrade Regression',
    'tech-port-05-upgrade-regression',
    'Prototype in isolation and compare uplift and regression against baseline.',
    '#7C3AED',
    'codex',
    '5단계 후보 프로토타입 및 비교 측정. 주 작업트리에 바로 이식하지 않고 격리된 최소 프로토타입으로 기능, 정확도, 지연, 처리량, 자원과 오류율을 A/B 비교한다. 실패 케이스와 성능 저하도 함께 기록한다.',
    0,
    1
  ),
  (
    'team_tech-port-06-improvement-debate',
    'org_technology-porting',
    '06 Improvement Debate',
    'tech-port-06-improvement-debate',
    'Compare direct port, adapter, reimplementation, defer, and reject options.',
    '#9333EA',
    'claude-code',
    '6단계 개선 방향 토론. 직접 이식, 래퍼·어댑터, 부분 포팅, 자체 재구현, 보류·거부를 유지보수 비용, 종속성, 복잡도, 운영 위험과 장기 로드맵 관점에서 비교하고 반대 의견과 반례를 포함한다.',
    0,
    1
  ),
  (
    'team_tech-port-07-value-gate-report',
    'org_technology-porting',
    '07 Value Gate Report',
    'tech-port-07-value-gate-report',
    'Issue the fail-closed port decision from accumulated evidence.',
    '#BE123C',
    'codex',
    '7단계 가치판단 게이트. 안전, 복구 가능성, 기능·성능, 유지보수, 라이선스와 적합성을 종합한다. 첫 부분에 정확히 한 줄 PORT_DECISION: APPROVE 또는 PORT_DECISION: REJECT를 기록하며 증거 부족 시 기본값은 거부다.',
    0,
    1
  ),
  (
    'team_tech-port-08-migration-implementation',
    'org_technology-porting',
    '08 Migration Implementation',
    'tech-port-08-migration-implementation',
    'Implement only the approved scope with rollback-ready minimal changes.',
    '#16A34A',
    'codex',
    '8단계 이식 작업. 직전 리포트의 PORT_DECISION: APPROVE가 없으면 코드·설정·DB를 변경하지 않는다. 승인 범위만 최소 변경으로 구현하고 사용자 기존 변경과 비밀정보를 보존한다.',
    0,
    1
  ),
  (
    'team_tech-port-09-post-migration-verify',
    'org_technology-porting',
    '09 Post-migration Verification',
    'tech-port-09-post-migration-verify',
    'Re-run tests and benchmarks and decide release or rollback.',
    '#0F766E',
    'cursor-agent',
    '9단계 사후 검증. 전체 테스트·타입검사·빌드·통합 검증과 기준선 벤치마크를 재실행한다. 성공기준 충족 시 RELEASE_READY, 중단 조건 초과 시 ROLLBACK_REQUIRED로 판정한다.',
    0,
    1
  )
ON CONFLICT(id) DO UPDATE SET
  organization_id=excluded.organization_id,
  name=excluded.name,
  description=excluded.description,
  color=excluded.color,
  lead=excluded.lead,
  charter=excluded.charter,
  is_always_on=0,
  is_active=1,
  updated_at=datetime('now');

INSERT OR IGNORE INTO team_members (id, team_id, member_type, member_ref)
VALUES
  ('member_port_01_cursor_agent', 'team_tech-port-01-source-discovery', 'provider', 'cursor-agent'),
  ('member_port_01_codex', 'team_tech-port-01-source-discovery', 'provider', 'codex'),
  ('member_port_01_opencode', 'team_tech-port-01-source-discovery', 'provider', 'opencode'),
  ('member_port_02_codex', 'team_tech-port-02-safety-license', 'provider', 'codex'),
  ('member_port_02_hermes', 'team_tech-port-02-safety-license', 'provider', 'hermes'),
  ('member_port_02_cursor', 'team_tech-port-02-safety-license', 'provider', 'cursor-agent'),
  ('member_port_03_opencode', 'team_tech-port-03-recovery-checkpoint', 'provider', 'opencode'),
  ('member_port_03_codex', 'team_tech-port-03-recovery-checkpoint', 'provider', 'codex'),
  ('member_port_03_cursor', 'team_tech-port-03-recovery-checkpoint', 'provider', 'cursor-agent'),
  ('member_port_04_opencode', 'team_tech-port-04-baseline-benchmark', 'provider', 'opencode'),
  ('member_port_04_hermes', 'team_tech-port-04-baseline-benchmark', 'provider', 'hermes'),
  ('member_port_04_codex', 'team_tech-port-04-baseline-benchmark', 'provider', 'codex'),
  ('member_port_05_codex', 'team_tech-port-05-upgrade-regression', 'provider', 'codex'),
  ('member_port_05_opencode', 'team_tech-port-05-upgrade-regression', 'provider', 'opencode'),
  ('member_port_05_cursor', 'team_tech-port-05-upgrade-regression', 'provider', 'cursor-agent'),
  ('member_port_06_claude', 'team_tech-port-06-improvement-debate', 'provider', 'claude-code'),
  ('member_port_06_opencode', 'team_tech-port-06-improvement-debate', 'provider', 'opencode'),
  ('member_port_06_codex', 'team_tech-port-06-improvement-debate', 'provider', 'codex'),
  ('member_port_07_codex', 'team_tech-port-07-value-gate-report', 'provider', 'codex'),
  ('member_port_07_opencode', 'team_tech-port-07-value-gate-report', 'provider', 'opencode'),
  ('member_port_07_hermes', 'team_tech-port-07-value-gate-report', 'provider', 'hermes'),
  ('member_port_08_codex', 'team_tech-port-08-migration-implementation', 'provider', 'codex'),
  ('member_port_08_opencode', 'team_tech-port-08-migration-implementation', 'provider', 'opencode'),
  ('member_port_08_cursor', 'team_tech-port-08-migration-implementation', 'provider', 'cursor-agent'),
  ('member_port_09_cursor', 'team_tech-port-09-post-migration-verify', 'provider', 'cursor-agent'),
  ('member_port_09_codex', 'team_tech-port-09-post-migration-verify', 'provider', 'codex'),
  ('member_port_09_hermes', 'team_tech-port-09-post-migration-verify', 'provider', 'hermes');


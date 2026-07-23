-- 078: Claude Commander/Judge + Codex Builder/Verifier + AGY Experience Challenge
-- 비대칭 Triad 회사를 실제 조직 그래프에 등록한다.

INSERT INTO organizations (id, name, slug, graph_type, manager)
VALUES (
  'org_nco-triad-ultra',
  'NCO Triad Ultra Performance Company',
  'nco-triad-ultra',
  'nova-ax',
  'claude-code'
)
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name,
  manager=excluded.manager,
  updated_at=datetime('now');

INSERT INTO teams (id, organization_id, name, slug, description, color, lead, charter)
VALUES
  (
    'team_triad-command-judge',
    'org_nco-triad-ultra',
    'Triad Command & Judge',
    'triad-command-judge',
    'Requirements, architecture, risk, merge ordering, and final decision.',
    '#7C3AED',
    'claude-code',
    '계획과 위험을 구조화하고 최종 판정을 내린다. 파일을 직접 수정하지 않으며 기계 검증 영수증을 재실행해 확인한다. 자연어 완료 주장은 증거로 인정하지 않는다.'
  ),
  (
    'team_triad-build-verify',
    'org_nco-triad-ultra',
    'Triad Build & Verify',
    'triad-build-verify',
    'Scoped implementation, tests, refactoring, integration, and evidence collection.',
    '#2563EB',
    'codex',
    '선언된 plannedPaths만 구현한다. 동시 작업은 격리 worktree 또는 서로 겹치지 않는 파일 소유권에서만 수행하고 빌드·테스트·행동 프로브 영수증을 남긴다.'
  ),
  (
    'team_triad-experience-challenge',
    'org_nco-triad-ultra',
    'Triad Experience Challenge',
    'triad-experience-challenge',
    'Reactive UI/UX, accessibility, state, and user-path adversarial review.',
    '#059669',
    'agy',
    'UI·UX·접근성·사용자 흐름 변경에만 reactive 참여한다. visual/DOM, a11y, user-path 증거를 모두 요구하고 재현 가능한 결함만 FIX로 판정한다.'
  )
ON CONFLICT(id) DO UPDATE SET
  organization_id=excluded.organization_id,
  description=excluded.description,
  color=excluded.color,
  lead=excluded.lead,
  charter=excluded.charter,
  updated_at=datetime('now');

INSERT OR IGNORE INTO team_members (id, team_id, member_type, member_ref)
VALUES
  ('member_triad_claude_provider', 'team_triad-command-judge', 'provider', 'claude-code'),
  ('member_triad_claude_session', 'team_triad-command-judge', 'nco-session', 'nova-macstudio-claude-4'),
  ('member_triad_codex_provider', 'team_triad-build-verify', 'provider', 'codex'),
  ('member_triad_codex_session', 'team_triad-build-verify', 'nco-session', 'codex-triad'),
  ('member_triad_agy_provider', 'team_triad-experience-challenge', 'provider', 'agy'),
  ('member_triad_agy_session', 'team_triad-experience-challenge', 'nco-session', 'antigravity');

INSERT OR IGNORE INTO team_goals (
  id, subject_kind, subject_id, period, period_key, title, metric,
  target_value, current_value, unit, status, note
)
VALUES (
  'goal_triad_5x_2026_07',
  'organization',
  'org_nco-triad-ultra',
  'monthly',
  '2026-07',
  '검증 통과 처리량 5배 인증',
  'median_verified_subtasks_per_wall_clock_hour_multiplier',
  5,
  0,
  'x',
  'active',
  'r>=3 paired receipts, false-pass/post-merge regression 없음, median parallel efficiency >0.7일 때만 달성으로 판정한다.'
);

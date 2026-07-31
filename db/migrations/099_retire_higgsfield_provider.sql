-- 099_retire_higgsfield_provider.sql
-- higgsfield 프로바이더 퇴출 (scripts/provider.ts 생성, 2026-07-30)
--
-- 설정/토폴로지 행만 정리한다. 과거 실행기록(tasks, work_events, agent_actions,
-- agent_invocations 등)은 "그때 무엇이 돌았는가"의 증거이자 team-scorer 의
-- 입력이므로 건드리지 않는다.

-- 1) 팀 lead 재배정 — team_members 삭제보다 먼저. lead 는 그 팀의 멤버여야 한다.
UPDATE teams
   SET lead = COALESCE(
         (SELECT tm.member_ref
            FROM team_members tm
           WHERE tm.team_id = teams.id
             AND tm.member_type = 'provider'
             AND tm.member_ref <> 'higgsfield'
           ORDER BY tm.rowid
           LIMIT 1),
         'opencode')
 WHERE lead = 'higgsfield';

UPDATE required_capabilities
   SET lead = COALESCE((SELECT t.lead FROM teams t WHERE t.id = required_capabilities.id), 'opencode')
 WHERE lead = 'higgsfield';

-- 2) 조직 manager 재배정. 헌정 5개 회사의 manager 는 서로 달라야 하므로
--    nco-government 만 따로 잡는다(086 계약).
UPDATE organizations          SET manager = 'hermes'   WHERE manager = 'higgsfield' AND slug = 'nco-government';
UPDATE organizations          SET manager = 'opencode' WHERE manager = 'higgsfield';
UPDATE required_organizations SET manager = 'hermes'   WHERE manager = 'higgsfield' AND slug = 'nco-government';
UPDATE required_organizations SET manager = 'opencode' WHERE manager = 'higgsfield';

-- 3) 팀 소속 해제
DELETE FROM team_members WHERE member_type = 'provider' AND member_ref = 'higgsfield';

-- 4) 정부 공직 재임명
UPDATE nova_civil_servants SET nco_agent_id = 'hermes' WHERE nco_agent_id = 'higgsfield';

-- 5) 동적 스킬 파이프라인 단계 교체
UPDATE dynamic_skills
   SET pipeline   = replace(pipeline, '"higgsfield"', '"opencode"'),
       updated_at = datetime('now')
 WHERE pipeline LIKE '%"higgsfield"%';

-- 6) 런타임 상태 및 등록 제거
DELETE FROM circuit_states   WHERE agent_id = 'higgsfield';
DELETE FROM rate_limit_state WHERE agent_id = 'higgsfield';
DELETE FROM agents           WHERE id = 'higgsfield';

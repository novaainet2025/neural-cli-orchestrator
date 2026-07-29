-- 098_retire_nvidia_provider.sql
-- nvidia(NVIDIA NIM API) 프로바이더 퇴출.
--
-- 대상: 앞으로의 동작을 결정하는 설정/토폴로지 행만 정리한다.
--   - agents 등록 행
--   - teams / required_capabilities 의 lead
--   - team_members 소속
--   - organizations / required_organizations 의 manager
--   - nova_civil_servants 임명
--   - 런타임 상태(circuit_states, rate_limit_state)
--   - dynamic_skills 파이프라인 단계
--
-- 재배정 규칙:
--   team lead  → 그 팀에 이미 소속된 다른 멤버 (teams.lead 는 반드시 team_members 에
--                존재해야 한다는 086 계약을 깨지 않기 위해 데이터 기반으로 고른다)
--   nco-government manager → hermes
--                (헌정 5개 회사의 manager 는 서로 달라야 한다는 086 계약)
--   그 외 manager / 파이프라인 추론 단계 → opencode
--   nova 정부 justice 부처 → hermes (src/nova/governmentService.ts 와 일치)
--
-- 과거 실행기록(tasks, agent_actions, work_events, agent_invocations,
-- discussions, work_reports, learning_events, decision_log 등)은 건드리지 않는다.
-- 해당 행들은 "그때 무엇이 실행됐는가"의 증거이며, team-scorer 의 입력이다.

-- 1) 팀 lead 재배정 — 반드시 team_members 삭제 *전에* 수행한다.
UPDATE teams
   SET lead = COALESCE(
         (SELECT tm.member_ref
            FROM team_members tm
           WHERE tm.team_id = teams.id
             AND tm.member_type = 'provider'
             AND tm.member_ref <> 'nvidia'
           ORDER BY tm.rowid
           LIMIT 1),
         'opencode')
 WHERE lead = 'nvidia';

UPDATE required_capabilities
   SET lead = COALESCE((SELECT t.lead FROM teams t WHERE t.id = required_capabilities.id), 'opencode')
 WHERE lead = 'nvidia';

-- 2) 조직 manager 재배정
UPDATE organizations          SET manager = 'hermes'   WHERE manager = 'nvidia' AND slug = 'nco-government';
UPDATE organizations          SET manager = 'opencode' WHERE manager = 'nvidia';
UPDATE required_organizations SET manager = 'hermes'   WHERE manager = 'nvidia' AND slug = 'nco-government';
UPDATE required_organizations SET manager = 'opencode' WHERE manager = 'nvidia';

-- 3) 팀 소속 해제
DELETE FROM team_members WHERE member_type = 'provider' AND member_ref = 'nvidia';

-- 4) Nova 정부 공직 재임명
UPDATE nova_civil_servants
   SET nco_agent_id = 'hermes',
       name         = replace(name, 'NVIDIA', 'Hermes')
 WHERE nco_agent_id = 'nvidia';

-- 5) 동적 스킬 파이프라인의 nvidia 단계를 opencode 로 교체
UPDATE dynamic_skills
   SET pipeline   = replace(pipeline, '"nvidia"', '"opencode"'),
       updated_at = datetime('now')
 WHERE pipeline LIKE '%"nvidia"%';

-- 6) 런타임 상태 및 에이전트 등록 제거
--    agent_ai_home 은 마이그레이션이 아니라 런타임에 생성되므로 여기서 다루지 않는다
--    (신규 DB 에는 테이블도 대상 행도 없다). 기존 DB 정리는 아래 참조:
--    DELETE FROM agent_ai_home WHERE agent_id = 'nvidia';
DELETE FROM circuit_states   WHERE agent_id = 'nvidia';
DELETE FROM rate_limit_state WHERE agent_id = 'nvidia';
DELETE FROM agents           WHERE id = 'nvidia';

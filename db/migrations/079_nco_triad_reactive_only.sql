-- 079: Triad는 team-runner 상시 임무가 아니라 API 이벤트 기반으로만 실행한다.
-- 특히 AGY는 UI/UX/a11y/user-flow trigger가 있을 때만 reactive 호출한다.

UPDATE organizations
SET is_always_on=0,
    schedule=NULL,
    updated_at=datetime('now')
WHERE id='org_nco-triad-ultra';

UPDATE teams
SET is_always_on=0,
    schedule=NULL,
    updated_at=datetime('now')
WHERE organization_id='org_nco-triad-ultra';

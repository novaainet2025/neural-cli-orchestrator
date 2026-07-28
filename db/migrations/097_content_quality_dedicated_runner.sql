-- team_content-quality is an event-driven gate owned by daily-blog-promo.sh.
-- Keep it active, but exclude it from team-runner's payload-free daily sweep.
-- Rollback after reverting this migration from the deployment:
-- UPDATE teams SET charter = LTRIM(SUBSTR(LTRIM(charter), LENGTH('@전담러너') + 1)),
--   updated_at = datetime('now')
--   WHERE id = 'team_content-quality' AND LTRIM(charter) LIKE '@전담러너 %';
-- UPDATE required_capabilities
--   SET charter = LTRIM(SUBSTR(LTRIM(charter), LENGTH('@전담러너') + 1))
--   WHERE id = 'team_content-quality' AND LTRIM(charter) LIKE '@전담러너 %';
UPDATE teams
SET
  charter = '@전담러너 ' || LTRIM(charter),
  updated_at = datetime('now')
WHERE id = 'team_content-quality'
  AND COALESCE(LTRIM(charter), '') <> ''
  AND LTRIM(charter) NOT LIKE '@전담러너%';

UPDATE required_capabilities
SET charter = '@전담러너 ' || LTRIM(charter)
WHERE id = 'team_content-quality'
  AND COALESCE(LTRIM(charter), '') <> ''
  AND LTRIM(charter) NOT LIKE '@전담러너%';

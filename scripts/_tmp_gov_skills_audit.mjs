import Database from 'better-sqlite3';

const db = new Database('/Users/nova-ai/project/nco/db/nco.db', { readonly: true });

console.log('===48H_TASKS===');
const tasks = db.prepare(`
SELECT id, status, assigned_to, substr(COALESCE(error,''),1,120) AS err, datetime(created_at) AS created
FROM tasks
WHERE (team_id='team_gov-evolution-skills' OR team_id='gov-evolution-skills')
  AND created_at >= datetime('now','-48 hours')
ORDER BY created_at DESC
`).all();
console.log(JSON.stringify(tasks, null, 2));
console.log('ROW_COUNT', tasks.length);

console.log('===ERROR_PATTERNS===');
const patterns = db.prepare(`
SELECT
  CASE
    WHEN lower(COALESCE(error,'')||' '||COALESCE(response,'')) LIKE '%circuit breaker%' OR lower(COALESCE(error,'')||' '||COALESCE(response,'')) LIKE '%circuitbreaker%' THEN 'CircuitBreaker'
    WHEN lower(COALESCE(error,'')||' '||COALESCE(response,'')) LIKE '%command gate%' OR lower(COALESCE(error,'')||' '||COALESCE(response,'')) LIKE '%command_gate%' OR lower(COALESCE(error,'')||' '||COALESCE(response,'')) LIKE '%denied by gate%' THEN 'CommandGate'
    WHEN lower(COALESCE(error,'')||' '||COALESCE(response,'')) LIKE '%rate limit%' OR lower(COALESCE(error,'')||' '||COALESCE(response,'')) LIKE '%rate_limit%' OR lower(COALESCE(error,'')||' '||COALESCE(response,'')) LIKE '%quota%' THEN 'RateLimit'
    ELSE 'other:'||substr(COALESCE(error,'none'),1,80)
  END AS pattern,
  COUNT(*) AS cnt,
  GROUP_CONCAT(id) AS task_ids
FROM tasks
WHERE (team_id='team_gov-evolution-skills' OR team_id='gov-evolution-skills')
  AND created_at >= datetime('now','-48 hours')
  AND status IN ('failed','lease_expired','cancelled','timeout')
GROUP BY 1
ORDER BY cnt DESC
`).all();
console.log(JSON.stringify(patterns, null, 2));
console.log('PATTERN_ROW_COUNT', patterns.length);

console.log('===HOURLY_ROLE_AUDITS===');
const audits = db.prepare(`
SELECT subject_kind, subject_id, COUNT(*) AS cnt
FROM hourly_role_audits
WHERE subject_id LIKE '%skill%' OR subject_id LIKE '%evolution%'
GROUP BY 1,2
`).all();
console.log(JSON.stringify(audits, null, 2));
console.log('AUDIT_ROW_COUNT', audits.length);

console.log('===STATUS_DIST===');
const dist = db.prepare(`
SELECT status, COUNT(*) AS cnt
FROM tasks
WHERE (team_id='team_gov-evolution-skills' OR team_id='gov-evolution-skills')
  AND created_at >= datetime('now','-48 hours')
GROUP BY status
`).all();
console.log(JSON.stringify(dist, null, 2));
console.log('DIST_ROW_COUNT', dist.length);

db.close();

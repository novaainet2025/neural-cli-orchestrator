# Independent verification evidence

- Subject task: `task_jxud-G21CtmA2SMD`
- Company: `org_nco-triad-ultra`
- Team: `team_triad-build-verify`
- Source database: `/Users/nova-ai/project/nco/db/nco.db`
- Source task created at: `2026-07-30 23:33:26` UTC
- Report row created at: `2026-07-30 23:28:36` UTC
- Artifact: `task-output.md`
- Artifact SHA-256:
  `c8559353ad6f29f5ae04d1118f6f32f9edefa39b624209352d2fef5886018e41`

## Task status snapshot

The active NCO database identifies the source task as `reviewing`, assigned to
`agy`, with `verificationStatus=pending`. The associated work-report row is
currently `missed`, so this audit does not claim that the reporting obligation
has already been satisfied.

## Seven-day task aggregate

Query window: `[2026-07-23 23:33:26, 2026-07-30 23:33:26)`.

```sql
SELECT COUNT(*) AS total,
       SUM(status='completed') AS completed,
       SUM(status IN ('failed','cancelled','timed_out')) AS failed,
       SUM(status IN ('pending','queued','running','working','reviewing')) AS in_progress,
       ROUND(100.0*SUM(status='completed')/COUNT(*),1) AS completion_rate
FROM tasks
WHERE team_id='team_triad-build-verify'
  AND created_at >= datetime('2026-07-30 23:33:26','-7 days')
  AND created_at < '2026-07-30 23:33:26';
```

Observed row:

```text
total  completed  failed  in_progress  completion_rate
21     19         2       0            90.5
```

## Work-report aggregate

The current AM report row is excluded because its creation is the cutoff.
Query window: `[2026-07-23 23:28:36, 2026-07-30 23:28:36)`.

```sql
SELECT status, COUNT(*) AS count
FROM work_reports
WHERE team_id='team_triad-build-verify'
  AND created_at >= datetime('2026-07-30 23:28:36','-7 days')
  AND created_at < '2026-07-30 23:28:36'
GROUP BY status
ORDER BY status;
```

Observed rows:

```text
status     count
missed     2
submitted  12
```

## Agent performance rows

```sql
SELECT agent_id, task_type, total_runs,
       printf('%.1f%%',success_rate*100.0) AS success_rate_percent,
       printf('%.2f',avg_quality) AS avg_quality,
       printf('%.2f',avg_duration_ms) AS avg_duration_ms
FROM agent_performance_summary
WHERE (agent_id='opencode' AND task_type IN ('code','design'))
   OR (agent_id='codex' AND task_type='code')
ORDER BY agent_id,task_type;
```

Observed rows:

```text
agent_id  task_type  total_runs  success_rate_percent  avg_quality  avg_duration_ms
codex     code       15          46.7%                 46.27        46602.67
opencode  code       26          80.8%                 68.47        33154.73
opencode  design     1           100.0%                82.57        50112.00
```

## Scope and gate facts before submission

- No verification run for `task_jxud-G21CtmA2SMD` existed in the active
  Nova-AX database before this audit.
- The only pre-existing approved run for this team was bound to a different
  task, `task_wDTvWo6OrBVEIiZP`, and therefore is not reusable.
- No remediation loop row existed for this company/team scope.
- Directive `vdir_5870d179-acab-43fb-b863-bda755a13858` was `queued`.

## Independent behavior probes

The probes were executed against the active NCO database and the artifact file.
Durations use a monotonic machine clock.

```json
{"name":"artifact-db-response-exact-match","exitCode":0,"durationMs":204,"commandHash":"beba782c9bdfc77acd8e4a32678fcd2b154c3fcc5a0b2a0d2a3acd74162da10f","outputHash":"624bd4249bb15f8bb68da4298b1f1f36d8255fc526b1640e5ecc86d376ea7714","stdout":"exact-match"}
{"name":"source-aggregate-sql-checks","exitCode":0,"durationMs":80,"commandHash":"16f69b2c76b5de7175dc3e63fff3330ebae190c633e284ecba527dc930c2e984","outputHash":"c8d3bb2b8a1330355232730efc1bf5090d69caea9f5469ef66b5ade27c1f7845","stdout":"{\"tasks\":\"21,19,2,0,90.5\",\"reports\":\"missed:2,submitted:12\",\"performance\":\"codex/code:15:46.7:46.27:46602.67|opencode/code:26:80.8:68.47:33154.73|opencode/design:1:100.0:82.57:50112.00\"}"}
```

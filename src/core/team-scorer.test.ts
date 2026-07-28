import Database from 'better-sqlite3';
import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeOrganizationScores, computeTeamScores } from './team-scorer.js';
import { registerTeamScoreRoutes } from '../server/routes/team-scores.js';

describe('team score aggregation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE organizations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE teams (
        id TEXT PRIMARY KEY, organization_id TEXT, name TEXT NOT NULL,
        slug TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, team_id TEXT, status TEXT NOT NULL,
        error TEXT, response TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        lease_expires_at TEXT,
        result_json TEXT
      );

      INSERT INTO organizations (id, name, is_active) VALUES
        ('org_active', 'Active Org', 1),
        ('org_inactive', 'Inactive Org', 0);
      INSERT INTO teams (id, organization_id, name, slug, is_active) VALUES
        ('team_alpha', 'org_active', 'Alpha', 'alpha', 1),
        ('team_beta', 'org_active', 'Beta', 'beta', 1),
        ('team_inactive', 'org_active', 'Inactive Team', 'inactive-team', 0),
        ('team_hidden', 'org_inactive', 'Hidden Team', 'hidden-team', 1);
    `);
    db.exec('ALTER TABLE tasks ADD COLUMN spawned_by_cli TEXT');
    db.exec('ALTER TABLE tasks ADD COLUMN acked_at TEXT');
    db.exec('ALTER TABLE tasks ADD COLUMN last_heartbeat_at TEXT');
    db.exec('ALTER TABLE tasks ADD COLUMN metadata_json TEXT');
    db.exec('ALTER TABLE tasks ADD COLUMN system_prompt TEXT');
    db.exec('ALTER TABLE tasks ADD COLUMN orphan_requeue_count INTEGER NOT NULL DEFAULT 0');

    const insert = db.prepare(`
      INSERT INTO tasks (id, team_id, status, response, created_at)
      VALUES (?, ?, ?, ?, datetime('now', ?))
    `);
    const insertWithError = db.prepare(`
      INSERT INTO tasks (id, team_id, status, error, created_at)
      VALUES (?, ?, ?, ?, datetime('now', ?))
    `);
    insert.run('a1', 'team_alpha', 'completed', 'report body', '-1 hour');
    insert.run('a2', 'team_alpha', 'completed', 'report body', '-2 hours');
    insert.run('a3', 'team_alpha', 'completed', 'report body', '-3 hours');
    insert.run('a4', 'team_alpha', 'failed', null, '-4 hours');
    insert.run('a-running', 'team_alpha', 'running', null, '-1 hour');
    // 인프라 기인 실패(서버 재시작 orphan)는 completion 분모에서 제외되어야 한다.
    // 이 행이 카운트되면 alpha n=5·completion=60이 되어 아래 기대값(n=4·completion=75)이 깨진다.
    insertWithError.run(
      'a-orphan', 'team_alpha', 'failed',
      'orphaned: server restart (poison — requeued 2x)', '-2 hours',
    );
    // 에이전트 가용성 서킷브레이커 실패도 인프라 이벤트라 분모에서 제외되어야 한다.
    // 이 행이 카운트되면 alpha n=5·completion=60이 되어 기대값(n=4·completion=75)이 깨진다.
    insertWithError.run(
      'a-circuit', 'team_alpha', 'failed',
      'Circuit breaker open for agent claude-code (generic)', '-2 hours',
    );
    // P2-4의 정직한 신규 문자열도 기존 문자열과 동일한 인프라 이벤트로 제외한다.
    insertWithError.run(
      'a-provider-unavailable', 'team_alpha', 'failed',
      'provider_unavailable: claude-code (open/quota)', '-2 hours',
    );

    insert.run('b1', 'team_beta', 'completed', 'report body', '-1 hour');
    insert.run('b2', 'team_beta', 'failed', null, '-3 days');
    insert.run('inactive-1', 'team_inactive', 'completed', 'report body', '-1 hour');
    insert.run('hidden-1', 'team_hidden', 'completed', 'report body', '-1 hour');
  });

  it('excludes only NCO gateway-down failures, keeping quotes and other server failures', () => {
    // team_kd-harness 회귀: 게이트웨이 다운 시 성과보고 태스크는 정직하게 실패 보고하지만
    // 팀 품질 신호가 아니라 인프라 가용성 이벤트다. terminal 분모에서 제외되어야 한다.
    const insertFull = db.prepare(`
      INSERT INTO tasks (id, team_id, status, error, response, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', ?))
    `);
    db.prepare(`INSERT INTO teams (id, organization_id, name, slug, is_active) VALUES (?, ?, ?, ?, 1)`)
      .run('team_gw', 'org_active', 'Gateway', 'gateway');

    // 정상 완료 1건.
    insertFull.run('gw-ok', 'team_gw', 'completed', null, 'goal+report posted 201', '-1 hour');
    // 게이트웨이 다운으로 실패한 2건 — 제외 대상.
    insertFull.run(
      'gw-down-1', 'team_gw', 'failed', 'unknown: failure pattern in output',
      "error: 목표설정 HTTP 호출이 실패했습니다.\ncurl: (7) Failed to connect to localhost port 6200 after 0 ms: Couldn't connect to server",
      '-2 hours',
    );
    insertFull.run(
      'gw-down-2', 'team_gw', 'failed', 'unknown: failure pattern in output',
      "curl: (7) Failed to connect to 127.0.0.1 port 6200: Couldn't connect to server",
      '-3 hours',
    );
    // 불변식 가드: 완료 보고서가 과거 연결오류를 인용해도(error NULL) terminal에서 빠지면 안 된다.
    insertFull.run(
      'gw-quote', 'team_gw', 'completed', null,
      "지난주 Couldn't connect to server 장애를 복구했고 오늘 201 확인.", '-4 hours',
    );
    // 범위 가드: 같은 error·curl 문구라도 NCO 포트가 아니면 팀 실패로 남아야 한다.
    insertFull.run(
      'other-server-down', 'team_gw', 'failed', 'unknown: failure pattern in output',
      "curl: (7) Failed to connect to localhost port 11434: Couldn't connect to server",
      '-5 hours',
    );

    const gateway = computeTeamScores(db).find((t) => t.teamId === 'team_gw');
    // 제외 후: terminal = {gw-ok, gw-quote, other-server-down} = 3,
    // completed = 2 → completion 66.7. NCO 포트 한정이 없으면 other-server-down까지
    // 빠져 n=2·completion=100으로 실패를 은폐한다.
    expect(gateway).toMatchObject({ completion: 66.7, n: 3 });
  });

  it('excludes commander-perfgoal control-plane tasks for any team while keeping charter tasks', () => {
    // team_quality-audit 회귀: commander-perfgoal은 목표/성과보고를 NCO 제어면에 입력하는
    // 관리 태스크라 팀 charter 산출물이 아니다. 에이전트가 미주입 필수값을 정상 거부하면
    // 실패로 마킹되는데, 이는 팀 감사 품질 신호가 아니므로 팀 무관하게 terminal에서 제외한다.
    // 범위 가드: 같은 팀의 non-perfgoal charter 태스크는 그대로 카운트되어야 한다(과잉 제외 방지).
    const insertTask = db.prepare(`
      INSERT INTO tasks (id, team_id, status, spawned_by_cli, response, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', ?))
    `);
    const insertTeam = db.prepare(`
      INSERT INTO teams (id, organization_id, name, slug, is_active)
      VALUES (?, 'org_active', ?, ?, 1)
    `);
    insertTeam.run('team_kd-memory', 'Memory Audit', 'kd-memory');
    insertTeam.run('team_control', 'Control', 'control');

    // 두 팀 모두 perfgoal 제어면 태스크 3건씩 — 팀 무관하게 전부 제외 대상.
    for (const teamId of ['team_kd-memory', 'team_control']) {
      insertTask.run(`${teamId}-admin-failed`, teamId, 'failed', 'commander-perfgoal', null, '-1 hour');
      insertTask.run(`${teamId}-admin-expired`, teamId, 'lease_expired', 'commander-perfgoal', null, '-2 hours');
      insertTask.run(`${teamId}-admin-completed`, teamId, 'completed', 'commander-perfgoal', null, '-3 hours');
    }
    // team_control은 실제 charter 태스크(비-perfgoal) 3건 보유 — 이건 그대로 카운트돼야 한다.
    insertTask.run('team_control-work-1', 'team_control', 'completed', 'team-runner', 'report body', '-1 hour');
    insertTask.run('team_control-work-2', 'team_control', 'completed', 'team-runner', 'report body', '-2 hours');
    insertTask.run('team_control-work-3', 'team_control', 'failed', 'team-runner', null, '-3 hours');

    const scores = computeTeamScores(db);
    // kd-memory: perfgoal 3건 전부 제외 → 표본 없음.
    expect(scores.find((team) => team.teamId === 'team_kd-memory')).toMatchObject({
      completion: 0,
      n: 0,
      sample: 'all',
    });
    // control: perfgoal 3건 제외, charter 3건만 남아 terminal=3·completed=2 → completion 66.7.
    // 제외가 과잉 적용돼 charter 태스크까지 빠지면 n=0이 되어 이 기대값이 깨진다.
    expect(scores.find((team) => team.teamId === 'team_control')).toMatchObject({
      completion: 66.7,
      n: 3,
      sample: '48h',
    });
  });

  it('excludes acked-but-never-ran lease expiries while keeping lease timeouts that produced heartbeats', () => {
    // team_triad-command-judge 회귀: 에이전트가 리스를 acked했으나 heartbeat 0으로 만료된
    // never-ran lease_expired는 서킷브레이커와 동일한 가용성 이벤트라 terminal에서 제외한다.
    // heartbeat가 있는 lease_expired(실작업 타임아웃)는 정상 품질 실패로 그대로 카운트한다.
    const insertLease = db.prepare(`
      INSERT INTO tasks (
        id, team_id, status, acked_at, last_heartbeat_at, response, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))
    `);
    db.prepare(`INSERT INTO teams (id, organization_id, name, slug, is_active) VALUES (?, ?, ?, ?, 1)`)
      .run('team_triad', 'org_active', 'Triad', 'triad');

    // 정상 완료 3건.
    insertLease.run('tri-ok-1', 'team_triad', 'completed', null, null, 'report body', '-1 hour');
    insertLease.run('tri-ok-2', 'team_triad', 'completed', null, null, 'report body', '-2 hours');
    insertLease.run('tri-ok-3', 'team_triad', 'completed', null, null, 'report body', '-3 hours');
    // acked됐지만 heartbeat 0으로 만료된 never-ran 3건 — 제외 대상(가용성 이벤트).
    insertLease.run('tri-never-1', 'team_triad', 'lease_expired', '2026-07-24 00:05:53', null, null, '-4 hours');
    insertLease.run('tri-never-2', 'team_triad', 'lease_expired', '2026-07-24 00:05:47', null, null, '-5 hours');
    insertLease.run('tri-never-3', 'team_triad', 'lease_expired', '2026-07-24 00:05:49', null, null, '-6 hours');
    // 범위 가드: heartbeat가 있는 lease_expired는 실작업 타임아웃이므로 실패로 남아야 한다.
    insertLease.run('tri-ran-timeout', 'team_triad', 'lease_expired', '2026-07-24 00:05:00', '2026-07-24 00:06:17', null, '-7 hours');
    // 범위 가드: acked_at이 없으면(리스를 잡지도 못함) 이 제외 규칙 대상이 아니다.
    insertLease.run('tri-noack', 'team_triad', 'lease_expired', null, null, null, '-8 hours');

    const triad = computeTeamScores(db).find((t) => t.teamId === 'team_triad');
    // 제외 후 terminal = {ok×3, ran-timeout, noack} = 5, completed = 3 → completion 60.
    // never-ran 3건을 제외하지 않으면 terminal=8·completion=37.5로 팀이 부당 감점된다.
    expect(triad).toMatchObject({ completion: 60, n: 5 });
  });

  it('excludes failed work-report fan-out siblings whose report was delivered by a completed copy', () => {
    // team_legal-counsel 회귀: 동일 workReportId를 여러 사본으로 팬아웃한 뒤 한 사본이 실보고서를
    // 완료했는데 나머지 중복 사본이 'silent-failure: empty output'으로 죽으면, 산출물은 이미
    // 배달됐으므로 그 실패는 팀 품질 신호가 아니라 스케줄러 레이스 아티팩트다 → terminal 제외.
    const insertMeta = db.prepare(`
      INSERT INTO tasks (id, team_id, status, error, metadata_json, response, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))
    `);
    db.prepare(`INSERT INTO teams (id, organization_id, name, slug, is_active) VALUES (?, ?, ?, ?, 1)`)
      .run('team_legal', 'org_active', 'Legal', 'legal');

    const wrA = JSON.stringify({ workReportId: 'wr_A' });
    // wr_A: 한 사본 완료 + 빈-산출 중복 사본 2건(제외 대상).
    insertMeta.run('legal-wrA-ok', 'team_legal', 'completed', null, wrA, 'report body', '-1 hour');
    insertMeta.run('legal-wrA-dup1', 'team_legal', 'failed', 'silent-failure: empty output', wrA, null, '-2 hours');
    insertMeta.run('legal-wrA-dup2', 'team_legal', 'failed', 'silent-failure: empty output', wrA, null, '-3 hours');
    // 범위 가드: 완료 형제가 없는 단독 빈-산출 실패(wr_B)는 실제 품질 실패라 그대로 카운트.
    insertMeta.run(
      'legal-wrB-fail', 'team_legal', 'failed', 'silent-failure: empty output',
      JSON.stringify({ workReportId: 'wr_B' }), null, '-4 hours',
    );

    const legal = computeTeamScores(db).find((t) => t.teamId === 'team_legal');
    // 제외 후 terminal = {wrA-ok, wrB-fail} = 2, completed = 1 → completion 50.
    // 중복 사본을 제외하지 않으면 terminal=4·completion=25로 팀이 부당 감점된다.
    expect(legal).toMatchObject({ completion: 50, n: 2 });
  });

  it('defers a failed work-report copy while its same-team fallback is active, and is env-reversible', () => {
    const insert = db.prepare(`
      INSERT INTO tasks (id, team_id, status, error, metadata_json, response, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))
    `);
    db.prepare(`
      INSERT INTO teams (id, organization_id, name, slug, is_active)
      VALUES (?, 'org_active', ?, ?, 1)
    `).run('team_retrying_report', 'Retrying Report', 'retrying-report');
    db.prepare(`
      INSERT INTO teams (id, organization_id, name, slug, is_active)
      VALUES (?, 'org_active', ?, ?, 1)
    `).run('team_retry_boundary', 'Retry Boundary', 'retry-boundary');

    for (let index = 1; index <= 7; index += 1) {
      insert.run(
        `retry-ok-${index}`,
        'team_retrying_report',
        'completed',
        null,
        null,
        'report body',
        `-${index} hours`,
      );
    }

    const retryMetadata = JSON.stringify({ workReportId: 'wr_active_retry' });
    // Treasury 실측 경합: provider 한도 실패와 동일 workReportId 폴백이 동시에 존재하던
    // HR 스냅샷에서 실패 사본이 먼저 계상돼 7/8=87.5%로 오진됐다.
    insert.run(
      'retry-provider-limit',
      'team_retrying_report',
      'failed',
      "subprocess exited with code 1: You've hit your weekly limit",
      retryMetadata,
      "You've hit your weekly limit",
      '-8 hours',
    );
    insert.run(
      'retry-active-fallback',
      'team_retrying_report',
      'running',
      null,
      retryMetadata,
      null,
      '-1 minute',
    );

    // 범위 가드: 같은 workReportId라도 다른 팀의 활성 사본은 이 팀의 실패를 숨기지 않는다.
    const otherMetadata = JSON.stringify({ workReportId: 'wr_other_team' });
    insert.run(
      'retry-other-team-active',
      'team_alpha',
      'running',
      null,
      otherMetadata,
      null,
      '-1 minute',
    );
    insert.run(
      'retry-unrelated-failure',
      'team_retry_boundary',
      'failed',
      'actual task failure',
      otherMetadata,
      null,
      '-9 hours',
    );
    insert.run(
      'retry-boundary-ok',
      'team_retry_boundary',
      'completed',
      null,
      null,
      'report body',
      '-8 hours',
    );

    const score = computeTeamScores(db).find((team) => team.teamId === 'team_retrying_report');
    expect(score).toMatchObject({ completion: 100, n: 7, sample: '48h' });
    expect(computeTeamScores(db).find((team) => team.teamId === 'team_retry_boundary')).toMatchObject({
      completion: 50,
      n: 2,
      sample: '48h',
    });

    const previous = process.env.NCO_SCORER_ACTIVE_WORK_REPORT_RETRY_EXCLUSION;
    process.env.NCO_SCORER_ACTIVE_WORK_REPORT_RETRY_EXCLUSION = 'off';
    try {
      const rolledBack = computeTeamScores(db);
      expect(rolledBack.find((team) => team.teamId === 'team_retrying_report')).toMatchObject({
        completion: 87.5,
        n: 8,
        sample: '48h',
      });
    } finally {
      if (previous === undefined) delete process.env.NCO_SCORER_ACTIVE_WORK_REPORT_RETRY_EXCLUSION;
      else process.env.NCO_SCORER_ACTIVE_WORK_REPORT_RETRY_EXCLUSION = previous;
    }
  });

  it('excludes repeated all-failed work-report fan-out but keeps a single failure with a cancelled sibling', () => {
    const insertMeta = db.prepare(`
      INSERT INTO tasks (
        id, team_id, status, error, metadata_json, acked_at, last_heartbeat_at, response,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
    `);
    const insertTeam = db.prepare(`
      INSERT INTO teams (id, organization_id, name, slug, is_active)
      VALUES (?, 'org_active', ?, ?, 1)
    `);
    insertTeam.run('team_research', 'Research Analysis', 'research-analysis');
    insertTeam.run('team_single_failure', 'Single Failure', 'single-failure');

    // team_research-analysis 실측 회귀: 완료 13건과 동일 workReportId의 heartbeat 보유
    // lease_expired 2건. 두 만료는 never-ran 제외 대상이 아니지만, 하나의 scheduler fan-out
    // 실패이므로 terminal 분모에서 함께 제외되어 13/13을 유지해야 한다.
    for (let index = 1; index <= 13; index += 1) {
      insertMeta.run(
        `research-ok-${index}`, 'team_research', 'completed', null, null,
        null, null, 'report body', `-${index} hours`,
      );
    }
    const duplicatedReport = JSON.stringify({ workReportId: 'wr_research_duplicate' });
    insertMeta.run(
      'research-expired-1', 'team_research', 'lease_expired', 'lease_expired',
      duplicatedReport, '2026-07-22 05:02:46', '2026-07-22 05:06:17', null, '-14 hours',
    );
    insertMeta.run(
      'research-expired-2', 'team_research', 'lease_expired', 'lease_expired',
      duplicatedReport, '2026-07-22 05:03:18', '2026-07-22 05:04:52', null, '-15 hours',
    );

    // 범위 가드: cancelled는 scorer의 실패 상태가 아니다. 같은 workReportId에 cancelled
    // 형제가 있어도 실제 failed 1건을 "2개 실패 fan-out"으로 오인해 제외하면 안 된다.
    insertMeta.run(
      'single-ok', 'team_single_failure', 'completed', null, null,
      null, null, 'report body', '-1 hour',
    );
    const singletonReport = JSON.stringify({ workReportId: 'wr_single_failure' });
    insertMeta.run(
      'single-failed', 'team_single_failure', 'failed', 'actual task failure',
      singletonReport, '2026-07-24 00:00:00', '2026-07-24 00:01:00', null, '-2 hours',
    );
    insertMeta.run(
      'single-cancelled', 'team_single_failure', 'cancelled', 'cancelled by operator',
      singletonReport, null, null, null, '-3 hours',
    );

    const scores = computeTeamScores(db);
    expect(scores.find((team) => team.teamId === 'team_research')).toMatchObject({
      completion: 100,
      n: 13,
      sample: '48h',
    });
    expect(scores.find((team) => team.teamId === 'team_single_failure')).toMatchObject({
      completion: 50,
      n: 2,
      sample: '48h',
    });
  });

  it('excludes provider spawn-failure (ENOENT) tasks that produced no output, and is env-reversible', () => {
    const insert = db.prepare(`
      INSERT INTO tasks (id, team_id, status, error, response, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))
    `);
    db.prepare(`
      INSERT INTO teams (id, organization_id, name, slug, is_active)
      VALUES (?, 'org_active', ?, ?, 1)
    `).run('team_spawn', 'Spawn Failure', 'spawn-failure');

    // team_content-planning 실측 회귀(2026-07-27): 계상 실패 1건이 task_content_generation의
    // 'cursor-agent: CLI failed exit=unknown — Command failed with ENOENT: cursor-agent …'
    // (response 0바이트·result_json 0바이트 = CLI 프로세스 미기동)이었다.
    for (let index = 1; index <= 7; index += 1) {
      insert.run(`spawn-ok-${index}`, 'team_spawn', 'completed', null, 'report body', null, `-${index} hours`);
    }
    insert.run(
      'spawn-enoent', 'team_spawn', 'failed',
      'cursor-agent: CLI failed exit=unknown — Command failed with ENOENT: cursor-agent --print',
      '', '', '-8 hours',
    );
    // 과잉 제외 방지 가드: 산출물을 낸 실패는 같은 error 문자열이어도 계속 카운트한다.
    insert.run(
      'spawn-enoent-with-output', 'team_spawn', 'failed',
      'codex: CLI failed exit=unknown — Command failed with ENOENT: codex --print',
      'partial output', null, '-9 hours',
    );

    const scores = computeTeamScores(db);
    expect(scores.find((team) => team.teamId === 'team_spawn')).toMatchObject({
      completion: 87.5,
      n: 8,
      sample: '48h',
    });

    const previous = process.env.NCO_SCORER_SPAWN_FAILURE_EXCLUSION;
    process.env.NCO_SCORER_SPAWN_FAILURE_EXCLUSION = 'off';
    try {
      const rolledBack = computeTeamScores(db);
      expect(rolledBack.find((team) => team.teamId === 'team_spawn')).toMatchObject({
        completion: 77.8,
        n: 9,
        sample: '48h',
      });
    } finally {
      if (previous === undefined) delete process.env.NCO_SCORER_SPAWN_FAILURE_EXCLUSION;
      else process.env.NCO_SCORER_SPAWN_FAILURE_EXCLUSION = previous;
    }
  });

  it('excludes only externally injected zero-output completions, keeps NCO zero-output failures, and is env-reversible', () => {
    const insert = db.prepare(`
      INSERT INTO tasks (
        id, team_id, status, error, response, result_json, metadata_json,
        system_prompt, spawned_by_cli, orphan_requeue_count, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
    `);
    db.prepare(`
      INSERT INTO teams (id, organization_id, name, slug, is_active)
      VALUES (?, 'org_active', ?, ?, 1)
    `).run('team_zero_output', 'Zero Output', 'zero-output');

    insert.run(
      'zero-response-output', 'team_zero_output', 'completed', null, 'report body', null,
      '{"source":"nco"}', null, 'team-runner', 0, '-1 hour',
    );
    insert.run(
      'zero-result-output', 'team_zero_output', 'completed', null, null, '{"ok":true}',
      '{"source":"nco"}', null, 'team-runner', 0, '-2 hours',
    );
    // NCO provenance가 있는 0B 완료는 실제 실행 실패이므로 terminal 분모에 남는다.
    insert.run(
      'zero-nco-no-output', 'team_zero_output', 'completed', null, '', '',
      '{"source":"nco"}', null, 'team-runner', 0, '-3 hours',
    );
    // task_trend_collector 실측 스냅샷: 외부 raw-SQL 주입 후 산출물 없이 completed 처리.
    insert.run(
      'zero-external-marker', 'team_zero_output', 'completed', null, '', '',
      null, null, null, 0, '-4 hours',
    );
    insert.run(
      'zero-real-failure', 'team_zero_output', 'failed', 'actual task failure', '', '',
      '{"source":"nco"}', null, 'team-runner', 0, '-5 hours',
    );

    const previousZeroOutput = process.env.NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION;
    const previousExternal = process.env.NCO_SCORER_EXTERNAL_ZERO_OUTPUT_EXCLUSION;
    process.env.NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION = 'on';
    process.env.NCO_SCORER_EXTERNAL_ZERO_OUTPUT_EXCLUSION = 'on';
    try {
      const scores = computeTeamScores(db);
      expect(scores.find((team) => team.teamId === 'team_zero_output')).toMatchObject({
        completion: 50,
        n: 4,
        sample: '48h',
      });
      expect(scores.every((team) => team.completion <= 100)).toBe(true);

      process.env.NCO_SCORER_EXTERNAL_ZERO_OUTPUT_EXCLUSION = 'off';
      const rolledBack = computeTeamScores(db);
      expect(rolledBack.find((team) => team.teamId === 'team_zero_output')).toMatchObject({
        completion: 40,
        n: 5,
        sample: '48h',
      });
      expect(rolledBack.every((team) => team.completion <= 100)).toBe(true);

      // 기존 zero-output 토글은 별개로 유지되며, 외부 행은 분자·분모에서 함께 제외된다.
      process.env.NCO_SCORER_EXTERNAL_ZERO_OUTPUT_EXCLUSION = 'on';
      process.env.NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION = 'off';
      const zeroOutputRolledBack = computeTeamScores(db);
      expect(zeroOutputRolledBack.find((team) => team.teamId === 'team_zero_output')).toMatchObject({
        completion: 75,
        n: 4,
        sample: '48h',
      });
      expect(zeroOutputRolledBack.every((team) => team.completion <= 100)).toBe(true);
    } finally {
      if (previousZeroOutput === undefined) delete process.env.NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION;
      else process.env.NCO_SCORER_ZERO_OUTPUT_COMPLETED_EXCLUSION = previousZeroOutput;
      if (previousExternal === undefined) delete process.env.NCO_SCORER_EXTERNAL_ZERO_OUTPUT_EXCLUSION;
      else process.env.NCO_SCORER_EXTERNAL_ZERO_OUTPUT_EXCLUSION = previousExternal;
    }
  });

  it('excludes provider credential-rejection (401) failures that produced only an error envelope, and is env-reversible', () => {
    const insert = db.prepare(`
      INSERT INTO tasks (id, team_id, status, error, response, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))
    `);
    db.prepare(`
      INSERT INTO teams (id, organization_id, name, slug, is_active)
      VALUES (?, 'org_active', ?, ?, 1)
    `).run('team_auth', 'Provider Auth', 'provider-auth');

    // team_gov-command-collaboration 실측 회귀(2026-07-27 17:20:57 UTC, task_4aq6FQ3yZuXoiTdK):
    // claude-code가 'provider_unavailable: claude-code (open/auth)'로 죽고 opencode로 재배정된 뒤,
    // opencode도 api.anthropic.com 401을 받아 오류 봉투 하나만 남기고 종료했다. 재배정이 error를
    // 덮어써 기존 'provider_unavailable:%' 절이 이 행을 놓쳤다.
    const authEnvelope = '{"type":"error","timestamp":1785172857324,"sessionID":"ses_x","error":'
      + '{"name":"APIError","data":{"message":"invalid x-api-key","statusCode":401,'
      + '"isRetryable":false,"metadata":{"url":"https://api.anthropic.com/v1/messages"}}}}';

    for (let index = 1; index <= 7; index += 1) {
      insert.run(`auth-ok-${index}`, 'team_auth', 'completed', null, 'report body', null, `-${index} hours`);
    }
    insert.run(
      'auth-401', 'team_auth', 'failed',
      "opencode: CLI failed exit=1 — Command failed with exit code 1: opencode run --format json '[NCO",
      authEnvelope, null, '-8 hours',
    );
    // 과잉 제외 방지 가드 (1): 팀 보고서 본문이 앞에 있고 401을 *인용*만 한 실패는 계속 카운트한다
    // (이 팀은 오류규약이 charter라 인용 가능성이 높다 → response가 봉투로 시작할 때만 제외).
    insert.run(
      'auth-401-quoted', 'team_auth', 'failed',
      'opencode: CLI failed exit=1 — Command failed with exit code 1',
      `프로토콜 감사 보고서: 어제 관측된 실패는 ${authEnvelope} 형태였다.`, null, '-9 hours',
    );
    // 과잉 제외 방지 가드 (2): CLI 프로세스 실패가 아닌 품질게이트 실패는 계속 카운트한다.
    insert.run(
      'auth-401-quality-gate', 'team_auth', 'failed',
      'quality_rejected: FORMAT_MISMATCH',
      authEnvelope, null, '-10 hours',
    );

    const scores = computeTeamScores(db);
    expect(scores.find((team) => team.teamId === 'team_auth')).toMatchObject({
      completion: 77.8,
      n: 9,
      sample: '48h',
    });

    const previous = process.env.NCO_SCORER_PROVIDER_AUTH_EXCLUSION;
    process.env.NCO_SCORER_PROVIDER_AUTH_EXCLUSION = 'off';
    try {
      const rolledBack = computeTeamScores(db);
      expect(rolledBack.find((team) => team.teamId === 'team_auth')).toMatchObject({
        completion: 70,
        n: 10,
        sample: '48h',
      });
    } finally {
      if (previous === undefined) delete process.env.NCO_SCORER_PROVIDER_AUTH_EXCLUSION;
      else process.env.NCO_SCORER_PROVIDER_AUTH_EXCLUSION = previous;
    }
  });

  it('excludes plaintext provider credential rejection without team output, and is env-reversible', () => {
    const insert = db.prepare(`
      INSERT INTO tasks (id, team_id, status, error, response, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))
    `);
    db.prepare(`
      INSERT INTO teams (id, organization_id, name, slug, is_active)
      VALUES (?, 'org_active', ?, ?, 1)
    `).run('team_plain_auth', 'Plain Provider Auth', 'plain-provider-auth');

    for (let index = 1; index <= 6; index += 1) {
      insert.run(
        `plain-auth-ok-${index}`,
        'team_plain_auth',
        'completed',
        null,
        'report body',
        null,
        `-${index} hours`,
      );
    }

    const authError = 'Invalid API key · Fix external API key';
    // HR Incubator 실측 회귀(2026-07-27 17:18:57 UTC, task_VnTZtkgkcpgPwPhy):
    // claude-code subprocess가 인증 오류 한 줄만 내고 에이전트 턴 전에 종료했다.
    insert.run(
      'plain-auth-rejected',
      'team_plain_auth',
      'failed',
      `subprocess exited with code 1: ${authError}`,
      `${authError}\n`,
      null,
      '-7 hours',
    );
    // 과잉 제외 방지 가드 (1): provider subprocess 실패가 아니면 같은 본문도 품질 실패로 남긴다.
    insert.run(
      'plain-auth-quality-gate',
      'team_plain_auth',
      'failed',
      'quality_rejected: FORMAT_MISMATCH',
      authError,
      null,
      '-8 hours',
    );
    // 과잉 제외 방지 가드 (2): 부분 산출물이 있으면 인증 문자열을 인용해도 실패로 남긴다.
    insert.run(
      'plain-auth-partial-output',
      'team_plain_auth',
      'failed',
      `subprocess exited with code 1: ${authError}`,
      `status: 부분 진단을 작성했습니다.\n${authError}`,
      null,
      '-9 hours',
    );
    // 과잉 제외 방지 가드 (3): 실측하지 않은 exit code는 같은 오류 본문이어도 실패로 남긴다.
    insert.run(
      'plain-auth-unobserved-exit',
      'team_plain_auth',
      'failed',
      `subprocess exited with code 2: ${authError}`,
      `${authError}\n`,
      null,
      '-10 hours',
    );

    const scores = computeTeamScores(db);
    expect(scores.find((team) => team.teamId === 'team_plain_auth')).toMatchObject({
      completion: 66.7,
      n: 9,
      sample: '48h',
    });

    const previous = process.env.NCO_SCORER_PROVIDER_AUTH_EXCLUSION;
    process.env.NCO_SCORER_PROVIDER_AUTH_EXCLUSION = 'off';
    try {
      const rolledBack = computeTeamScores(db);
      expect(rolledBack.find((team) => team.teamId === 'team_plain_auth')).toMatchObject({
        completion: 60,
        n: 10,
        sample: '48h',
      });
    } finally {
      if (previous === undefined) delete process.env.NCO_SCORER_PROVIDER_AUTH_EXCLUSION;
      else process.env.NCO_SCORER_PROVIDER_AUTH_EXCLUSION = previous;
    }
  });

  it('excludes cursor-agent plaintext credential rejection without team output, and is env-reversible', () => {
    const insert = db.prepare(`
      INSERT INTO tasks (id, team_id, status, error, response, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))
    `);
    db.prepare(`
      INSERT INTO teams (id, organization_id, name, slug, is_active)
      VALUES (?, 'org_active', ?, ?, 1)
    `).run('team_cursor_auth', 'Cursor Provider Auth', 'cursor-provider-auth');

    for (let index = 1; index <= 6; index += 1) {
      insert.run(
        `cursor-auth-ok-${index}`,
        'team_cursor_auth',
        'completed',
        null,
        'report body',
        null,
        `-${index} hours`,
      );
    }

    const authText =
      "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.";
    // 실측 회귀(2026-07-27 17:21:41 UTC, task_IkKQEYErfegOFc6R·task_u_VTwDmVodFpsNDX):
    // cursor-agent CLI가 평문 인증 거부 한 줄만 내고 종료했고, 직후 동일 provider의
    // 서킷브레이커가 열려 후속 12건은 이미 INFRA_EXCLUSION으로 빠졌다.
    insert.run(
      'cursor-auth-rejected',
      'team_cursor_auth',
      'failed',
      `cursor-agent: CLI failed exit=1 — ${authText}`,
      `${authText}\n`,
      null,
      '-7 hours',
    );
    // 과잉 제외 방지 가드 (1): provider CLI 실패가 아니면 같은 본문도 품질 실패로 남긴다.
    insert.run(
      'cursor-auth-quality-gate',
      'team_cursor_auth',
      'failed',
      'quality_rejected: FORMAT_MISMATCH',
      `${authText}\n`,
      null,
      '-8 hours',
    );
    // 과잉 제외 방지 가드 (2): 부분 산출물이 있으면 인증 문구를 인용해도 실패로 남긴다.
    insert.run(
      'cursor-auth-partial-output',
      'team_cursor_auth',
      'failed',
      `cursor-agent: CLI failed exit=1 — ${authText}`,
      `status: 부분 진단을 작성했습니다.\n${authText}`,
      null,
      '-9 hours',
    );
    // 과잉 제외 방지 가드 (3): result_json이 남아 있으면 에이전트 턴이 성립한 것이므로 남긴다.
    insert.run(
      'cursor-auth-with-result',
      'team_cursor_auth',
      'failed',
      `cursor-agent: CLI failed exit=1 — ${authText}`,
      `${authText}\n`,
      '{"artifacts":1}',
      '-10 hours',
    );

    const scores = computeTeamScores(db);
    expect(scores.find((team) => team.teamId === 'team_cursor_auth')).toMatchObject({
      completion: 66.7,
      n: 9,
      sample: '48h',
    });

    const previous = process.env.NCO_SCORER_PROVIDER_AUTH_EXCLUSION;
    process.env.NCO_SCORER_PROVIDER_AUTH_EXCLUSION = 'off';
    try {
      const rolledBack = computeTeamScores(db);
      expect(rolledBack.find((team) => team.teamId === 'team_cursor_auth')).toMatchObject({
        completion: 60,
        n: 10,
        sample: '48h',
      });
    } finally {
      if (previous === undefined) delete process.env.NCO_SCORER_PROVIDER_AUTH_EXCLUSION;
      else process.env.NCO_SCORER_PROVIDER_AUTH_EXCLUSION = previous;
    }
  });

  afterEach(() => db.close());

  it('aggregates scores and serves the live team and organization arrays', async () => {
    const teams = computeTeamScores(db);

    expect(teams).toEqual([
      {
        teamId: 'team_alpha',
        slug: 'alpha',
        name: 'Alpha',
        organizationId: 'org_active',
        score: 77.5,
        grade: 'C',
        completion: 75,
        n: 4,
        maxN: 4,
        sample: '48h',
      },
      {
        teamId: 'team_beta',
        slug: 'beta',
        name: 'Beta',
        organizationId: 'org_active',
        score: 50,
        grade: 'F',
        completion: 50,
        n: 2,
        maxN: 4,
        sample: '7d',
      },
    ]);

    expect(computeOrganizationScores(db, teams)).toEqual([
      {
        orgId: 'org_active',
        name: 'Active Org',
        score: 63.8,
        grade: 'D',
        teams: 2,
        belowTarget: [
          { teamId: 'team_alpha', slug: 'alpha', name: 'Alpha', score: 77.5, grade: 'C' },
          { teamId: 'team_beta', slug: 'beta', name: 'Beta', score: 50, grade: 'F' },
        ],
      },
    ]);

    const app = fastify({ logger: false });
    await registerTeamScoreRoutes(app, db);
    const [teamResponse, organizationResponse] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/teams/scores' }),
      app.inject({ method: 'GET', url: '/api/org/scores' }),
    ]);
    expect(teamResponse.statusCode).toBe(200);
    expect(teamResponse.json()).toEqual(teams);
    expect(organizationResponse.statusCode).toBe(200);
    expect(organizationResponse.json()[0]).toMatchObject({
      orgId: 'org_active',
      score: 63.8,
      grade: 'D',
      teams: 2,
    });
    await app.close();
  });
});

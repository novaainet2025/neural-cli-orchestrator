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
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

    const insert = db.prepare(`
      INSERT INTO tasks (id, team_id, status, created_at)
      VALUES (?, ?, ?, datetime('now', ?))
    `);
    const insertWithError = db.prepare(`
      INSERT INTO tasks (id, team_id, status, error, created_at)
      VALUES (?, ?, ?, ?, datetime('now', ?))
    `);
    insert.run('a1', 'team_alpha', 'completed', '-1 hour');
    insert.run('a2', 'team_alpha', 'completed', '-2 hours');
    insert.run('a3', 'team_alpha', 'completed', '-3 hours');
    insert.run('a4', 'team_alpha', 'failed', '-4 hours');
    insert.run('a-running', 'team_alpha', 'running', '-1 hour');
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

    insert.run('b1', 'team_beta', 'completed', '-1 hour');
    insert.run('b2', 'team_beta', 'failed', '-3 days');
    insert.run('inactive-1', 'team_inactive', 'completed', '-1 hour');
    insert.run('hidden-1', 'team_hidden', 'completed', '-1 hour');
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
      INSERT INTO tasks (id, team_id, status, spawned_by_cli, created_at)
      VALUES (?, ?, ?, ?, datetime('now', ?))
    `);
    const insertTeam = db.prepare(`
      INSERT INTO teams (id, organization_id, name, slug, is_active)
      VALUES (?, 'org_active', ?, ?, 1)
    `);
    insertTeam.run('team_kd-memory', 'Memory Audit', 'kd-memory');
    insertTeam.run('team_control', 'Control', 'control');

    // 두 팀 모두 perfgoal 제어면 태스크 3건씩 — 팀 무관하게 전부 제외 대상.
    for (const teamId of ['team_kd-memory', 'team_control']) {
      insertTask.run(`${teamId}-admin-failed`, teamId, 'failed', 'commander-perfgoal', '-1 hour');
      insertTask.run(`${teamId}-admin-expired`, teamId, 'lease_expired', 'commander-perfgoal', '-2 hours');
      insertTask.run(`${teamId}-admin-completed`, teamId, 'completed', 'commander-perfgoal', '-3 hours');
    }
    // team_control은 실제 charter 태스크(비-perfgoal) 3건 보유 — 이건 그대로 카운트돼야 한다.
    insertTask.run('team_control-work-1', 'team_control', 'completed', 'team-runner', '-1 hour');
    insertTask.run('team_control-work-2', 'team_control', 'completed', 'team-runner', '-2 hours');
    insertTask.run('team_control-work-3', 'team_control', 'failed', 'team-runner', '-3 hours');

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
      INSERT INTO tasks (id, team_id, status, acked_at, last_heartbeat_at, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', ?))
    `);
    db.prepare(`INSERT INTO teams (id, organization_id, name, slug, is_active) VALUES (?, ?, ?, ?, 1)`)
      .run('team_triad', 'org_active', 'Triad', 'triad');

    // 정상 완료 3건.
    insertLease.run('tri-ok-1', 'team_triad', 'completed', null, null, '-1 hour');
    insertLease.run('tri-ok-2', 'team_triad', 'completed', null, null, '-2 hours');
    insertLease.run('tri-ok-3', 'team_triad', 'completed', null, null, '-3 hours');
    // acked됐지만 heartbeat 0으로 만료된 never-ran 3건 — 제외 대상(가용성 이벤트).
    insertLease.run('tri-never-1', 'team_triad', 'lease_expired', '2026-07-24 00:05:53', null, '-4 hours');
    insertLease.run('tri-never-2', 'team_triad', 'lease_expired', '2026-07-24 00:05:47', null, '-5 hours');
    insertLease.run('tri-never-3', 'team_triad', 'lease_expired', '2026-07-24 00:05:49', null, '-6 hours');
    // 범위 가드: heartbeat가 있는 lease_expired는 실작업 타임아웃이므로 실패로 남아야 한다.
    insertLease.run('tri-ran-timeout', 'team_triad', 'lease_expired', '2026-07-24 00:05:00', '2026-07-24 00:06:17', '-7 hours');
    // 범위 가드: acked_at이 없으면(리스를 잡지도 못함) 이 제외 규칙 대상이 아니다.
    insertLease.run('tri-noack', 'team_triad', 'lease_expired', null, null, '-8 hours');

    const triad = computeTeamScores(db).find((t) => t.teamId === 'team_triad');
    // 제외 후 terminal = {ok×3, ran-timeout, noack} = 5, completed = 3 → completion 60.
    // never-ran 3건을 제외하지 않으면 terminal=8·completion=37.5로 팀이 부당 감점된다.
    expect(triad).toMatchObject({ completion: 60, n: 5 });
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

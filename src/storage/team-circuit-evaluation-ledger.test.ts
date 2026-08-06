import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  reconcileLegacyTeamCircuits,
  refreshTeamCircuitFromRecentFailures,
  teamCircuitAgentId,
} from '../security/team-circuit-guard.js';

const migration059Sql = readFileSync(
  resolve(process.cwd(), 'db/migrations/059_circuit_states.sql'),
  'utf8',
);
const migration116Sql = readFileSync(
  resolve(process.cwd(), 'db/migrations/116_team_circuit_failure_watermark.sql'),
  'utf8',
);
const migration118Sql = readFileSync(
  resolve(process.cwd(), 'db/migrations/118_reconcile_legacy_team_circuits.sql'),
  'utf8',
);
const migration119Sql = readFileSync(
  resolve(process.cwd(), 'db/migrations/119_team_circuit_task_evaluation_ledger.sql'),
  'utf8',
);
const migration120Sql = readFileSync(
  resolve(process.cwd(), 'db/migrations/120_backfill_team_circuit_evaluations_from_watermarks.sql'),
  'utf8',
);

describe('119 team circuit task evaluation ledger', () => {
  let db: Database.Database;
  const originalToggle = process.env.NCO_TEAM_CIRCUIT_GUARD;

  beforeEach(() => {
    process.env.NCO_TEAM_CIRCUIT_GUARD = 'on';
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        team_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT,
        completed_at TEXT
      );
    `);
  });

  afterEach(() => {
    db.close();
    if (originalToggle === undefined) delete process.env.NCO_TEAM_CIRCUIT_GUARD;
    else process.env.NCO_TEAM_CIRCUIT_GUARD = originalToggle;
  });

  function applyUpgrade(): void {
    db.exec(migration059Sql);
    db.exec(migration116Sql);
    db.exec(migration118Sql);
    db.transaction(() => db.exec(migration119Sql)).immediate();
    db.transaction(() => db.exec(migration120Sql)).immediate();
  }

  it('supports the fresh 059 -> 116 -> 118 -> 119 -> 120 path and repeat execution', () => {
    applyUpgrade();
    db.transaction(() => db.exec(migration119Sql)).immediate();
    db.transaction(() => db.exec(migration120Sql)).immediate();

    const columns = db.prepare(`
      PRAGMA table_info(team_circuit_task_evaluations)
    `).all() as Array<{ name: string; pk: number }>;
    expect(columns.find(column => column.name === 'task_id')).toMatchObject({ pk: 1 });
    expect(columns.map(column => column.name)).toEqual([
      'task_id',
      'team_id',
      'task_rowid',
      'observed_status',
      'consumed_by',
      'consumed_at',
    ]);
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='index' AND name='idx_team_circuit_task_evaluations_team_row'
    `).get()).toEqual({ name: 'idx_team_circuit_task_evaluations_team_row' });
  });

  // **소스 저장소 안에서만 실행되는 가드다.** 배포된 dist 만 있는 환경에는 `.ts` 원문이
  // 없어 구조적으로 통과가 불가능하다(kangnote 실측 2026-08-07: 활성본 전량 실행 시
  // 이 두 건이 ENOENT 로 남는 유일한 실패였다).
  //
  // 하드 실패보다 **명시적 스킵**이 낫다 — 실패로 남으면 진짜 회귀와 구분이 안 된다.
  // 다만 조용한 스킵은 가드를 약하게 만드므로, 소스가 있는 환경(개발기·CI)에서는
  // 그대로 전력으로 돈다. 근본 해결은 dist 에 테스트를 넣지 않거나(A),
  // 빌드 시점 매니페스트를 함께 배포해 그것을 검사하는 것(C)이다.
  const MAIN_SOURCE = resolve(process.cwd(), 'src/index.ts');
  const WORKER_SOURCE = resolve(process.cwd(), 'src/worker.ts');
  const sourcesAvailable = existsSync(MAIN_SOURCE) && existsSync(WORKER_SOURCE);
  it.skipIf(!sourcesAvailable)('wires runtime reconciliation after migrations and before gateway or worker admission', () => {
    const mainSource = readFileSync(MAIN_SOURCE, 'utf8');
    const workerSource = readFileSync(WORKER_SOURCE, 'utf8');
    // Startup may wrap migrations in bounded SQLITE_BUSY retry logic. Assert
    // the call order without coupling the test to the surrounding statement.
    const mainMigration = mainSource.indexOf('runMigrations()');
    const mainReconcile = mainSource.indexOf('reconcileLegacyTeamCircuits(db)');
    const mainRecoveryAdmission = mainSource.indexOf(
      'const orphanRecovery = recoverOrphanedTasks();',
    );
    const mainGateway = mainSource.indexOf('gateway = await createGateway();');
    expect(mainMigration).toBeGreaterThan(-1);
    expect(mainReconcile).toBeGreaterThan(mainMigration);
    expect(mainRecoveryAdmission).toBeGreaterThan(mainReconcile);
    expect(mainGateway).toBeGreaterThan(mainRecoveryAdmission);

    const workerMigration = workerSource.indexOf('runMigrations()');
    const workerReconcile = workerSource.indexOf(
      'const teamCircuitReconcile = reconcileLegacyTeamCircuits(getDb());',
    );
    const workerAdmission = workerSource.indexOf('await taskQueue.init(loadEnabledProviders());');
    expect(workerMigration).toBeGreaterThan(-1);
    expect(workerReconcile).toBeGreaterThan(workerMigration);
    expect(workerAdmission).toBeGreaterThan(workerReconcile);
  });

  it('consumes only a generic team cohort and preserves classified team and provider circuits', () => {
    db.exec(migration059Sql);
    db.exec(migration116Sql);
    const insertTask = db.prepare(`
      INSERT INTO tasks (id, team_id, status, error) VALUES (?, ?, ?, ?)
    `);
    insertTask.run('legacy-failed', 'legacy-team', 'failed', 'old quality');
    insertTask.run('legacy-timeout', 'legacy-team', 'timed_out', 'timeout(hardcap)');
    insertTask.run('legacy-assigned', 'legacy-team', 'assigned', null);
    insertTask.run('quality-failed', 'quality-team', 'failed', 'new quality');
    const insertCircuit = db.prepare(`
      INSERT INTO circuit_states (
        agent_id, state, failure_count, opened_at, cooldown_until, reason,
        last_evaluated_task_rowid
      ) VALUES (?, 'open', ?, 100, 200, ?, ?)
    `);
    insertCircuit.run('team:legacy-team', 8, 'generic', 0);
    insertCircuit.run('team:quality-team', 2, 'team-failure:new quality', 7);
    insertCircuit.run('codex', 4, 'generic', 9);

    db.exec(migration118Sql);
    db.transaction(() => db.exec(migration119Sql)).immediate();
    db.transaction(() => db.exec(migration120Sql)).immediate();

    expect(db.prepare(`
      SELECT state, failure_count, opened_at, cooldown_until, reason
      FROM circuit_states WHERE agent_id='team:legacy-team'
    `).get()).toEqual({
      state: 'closed',
      failure_count: 0,
      opened_at: null,
      cooldown_until: null,
      reason: null,
    });
    expect(db.prepare(`
      SELECT task_id, team_id, observed_status, consumed_by
      FROM team_circuit_task_evaluations ORDER BY task_rowid
    `).all()).toEqual([
      {
        task_id: 'legacy-failed',
        team_id: 'legacy-team',
        observed_status: 'failed',
        consumed_by: 'watermark_backfill',
      },
      {
        task_id: 'legacy-timeout',
        team_id: 'legacy-team',
        observed_status: 'timed_out',
        consumed_by: 'watermark_backfill',
      },
      {
        task_id: 'quality-failed',
        team_id: 'quality-team',
        observed_status: 'failed',
        consumed_by: 'watermark_backfill',
      },
    ]);
    expect(db.prepare(`
      SELECT agent_id, state, failure_count, reason, last_evaluated_task_rowid
      FROM circuit_states WHERE agent_id IN ('codex', 'team:quality-team')
      ORDER BY agent_id
    `).all()).toEqual([
      {
        agent_id: 'codex',
        state: 'open',
        failure_count: 4,
        reason: 'generic',
        last_evaluated_task_rowid: 9,
      },
      {
        agent_id: 'team:quality-team',
        state: 'open',
        failure_count: 2,
        reason: 'team-failure:new quality',
        last_evaluated_task_rowid: 7,
      },
    ]);
  });

  it('evaluates a pre-migration assigned task after it fails and opens with one new failure', () => {
    db.exec(migration059Sql);
    db.exec(migration116Sql);
    const insert = db.prepare(`
      INSERT INTO tasks (id, team_id, status, error) VALUES (?, 'late-team', ?, ?)
    `);
    insert.run('created-before-reconcile', 'assigned', null);
    insert.run('historical-failure', 'failed', 'historical quality');
    db.prepare(`
      INSERT INTO circuit_states (
        agent_id, state, failure_count, opened_at, cooldown_until, reason,
        last_evaluated_task_rowid
      ) VALUES ('team:late-team', 'open', 2, 100, 200, 'generic', NULL)
    `).run();
    db.exec(migration118Sql);
    db.transaction(() => db.exec(migration119Sql)).immediate();
    db.transaction(() => db.exec(migration120Sql)).immediate();

    expect(db.prepare(`
      SELECT task_id FROM team_circuit_task_evaluations ORDER BY task_rowid
    `).all()).toEqual([{ task_id: 'historical-failure' }]);
    db.prepare(`
      UPDATE tasks
      SET status='failed', error='post-reconcile quality', updated_at=datetime('now')
      WHERE id='created-before-reconcile'
    `).run();
    insert.run('created-after-reconcile', 'failed', 'post-reconcile quality');

    expect(refreshTeamCircuitFromRecentFailures(db, 'late-team')).toBe(true);
    expect(db.prepare(`
      SELECT state, failure_count, reason FROM circuit_states
      WHERE agent_id=?
    `).get(teamCircuitAgentId('late-team'))).toEqual({
      state: 'open',
      failure_count: 2,
      reason: 'team-failure:post-reconcile quality',
    });
    expect(db.prepare(`
      SELECT task_id FROM team_circuit_task_evaluations
      WHERE team_id='late-team' ORDER BY task_rowid
    `).all()).toEqual([
      { task_id: 'created-before-reconcile' },
      { task_id: 'historical-failure' },
      { task_id: 'created-after-reconcile' },
    ]);
  });

  it('cleans a recurring generic row at startup and is idempotent', () => {
    applyUpgrade();
    db.prepare(`
      INSERT INTO tasks (id, team_id, status, error)
      VALUES ('legacy-writer-failure', 'recurring-team', 'lease_expired', 'lease expired')
    `).run();
    db.prepare(`
      INSERT INTO circuit_states (
        agent_id, state, failure_count, opened_at, cooldown_until, reason,
        last_evaluated_task_rowid
      ) VALUES ('team:recurring-team', 'open', 19, 100, 200, 'generic', NULL)
    `).run();

    expect(reconcileLegacyTeamCircuits(db)).toEqual({
      circuitsClosed: 1,
      tasksConsumed: 1,
    });
    expect(reconcileLegacyTeamCircuits(db)).toEqual({
      circuitsClosed: 0,
      tasksConsumed: 0,
    });
    expect(db.prepare(`
      SELECT state, failure_count, reason FROM circuit_states
      WHERE agent_id='team:recurring-team'
    `).get()).toEqual({ state: 'closed', failure_count: 0, reason: null });
  });

  it('rolls ledger inserts back when legacy circuit reset fails', () => {
    applyUpgrade();
    db.prepare(`
      INSERT INTO tasks (id, team_id, status, error)
      VALUES ('atomic-failure', 'atomic-team', 'failed', 'quality regression')
    `).run();
    db.prepare(`
      INSERT INTO circuit_states (
        agent_id, state, failure_count, opened_at, cooldown_until, reason,
        last_evaluated_task_rowid
      ) VALUES ('team:atomic-team', 'open', 2, 100, 200, 'generic', NULL)
    `).run();
    db.exec(`
      CREATE TRIGGER abort_legacy_team_reset
      BEFORE UPDATE ON circuit_states
      WHEN OLD.agent_id='team:atomic-team'
      BEGIN
        SELECT RAISE(ABORT, 'simulated circuit reset failure');
      END;
    `);

    expect(() => reconcileLegacyTeamCircuits(db)).toThrow('simulated circuit reset failure');
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM team_circuit_task_evaluations
      WHERE task_id='atomic-failure'
    `).get()).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT state, reason FROM circuit_states WHERE agent_id='team:atomic-team'
    `).get()).toEqual({ state: 'open', reason: 'generic' });
  });

  it('rolls cohort consumption back when opening the circuit fails', () => {
    applyUpgrade();
    const insert = db.prepare(`
      INSERT INTO tasks (id, team_id, status, error)
      VALUES (?, 'atomic-open-team', 'failed', 'quality regression')
    `);
    insert.run('atomic-open-1');
    insert.run('atomic-open-2');
    db.exec(`
      CREATE TRIGGER abort_team_circuit_open
      BEFORE INSERT ON circuit_states
      WHEN NEW.agent_id='team:atomic-open-team'
      BEGIN
        SELECT RAISE(ABORT, 'simulated circuit open failure');
      END;
    `);

    expect(() => refreshTeamCircuitFromRecentFailures(db, 'atomic-open-team'))
      .toThrow('simulated circuit open failure');
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM team_circuit_task_evaluations
      WHERE team_id='atomic-open-team'
    `).get()).toEqual({ count: 0 });
  });
});

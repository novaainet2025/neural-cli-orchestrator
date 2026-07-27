import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReportPrompt, buildTeamDataContext } from './work-report-scheduler.js';

describe('work report real-data context', () => {
  let db: Database.Database;
  const originalEvolutionLearningContextFlag =
    process.env.NCO_EVOLUTION_LEARNING_EVIDENCE_CONTEXT;

  beforeEach(() => {
    delete process.env.NCO_EVOLUTION_LEARNING_EVIDENCE_CONTEXT;
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE teams (id TEXT PRIMARY KEY, slug TEXT NOT NULL, lead TEXT);
      CREATE TABLE team_members (
        id TEXT PRIMARY KEY, team_id TEXT NOT NULL, member_type TEXT NOT NULL,
        member_ref TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, team_id TEXT, status TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '', response TEXT, error TEXT,
        result_json TEXT, evidence_json TEXT, metadata_json TEXT,
        created_at TEXT DEFAULT (datetime('now')), completed_at TEXT
      );
      CREATE TABLE learning_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
        event_type TEXT, pattern TEXT, context TEXT,
        auto_applied INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE work_reports (
        id TEXT PRIMARY KEY, team_id TEXT, report_date TEXT NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE agent_performance_summary (
        agent_id TEXT NOT NULL, task_type TEXT NOT NULL, total_runs INTEGER NOT NULL,
        success_rate REAL NOT NULL, avg_quality REAL NOT NULL, avg_duration_ms REAL NOT NULL
      );
      CREATE TABLE metrics (
        id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, metric_type TEXT NOT NULL,
        value REAL NOT NULL, created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE improvement_notes (
        id TEXT PRIMARY KEY, timestamp TEXT DEFAULT (datetime('now')),
        category TEXT NOT NULL, problem TEXT NOT NULL, root_cause TEXT NOT NULL,
        fix TEXT NOT NULL, verified_at TEXT, agent TEXT NOT NULL, severity TEXT NOT NULL
      );
      CREATE TABLE nova_wallets (address TEXT PRIMARY KEY, balance INTEGER NOT NULL, locked INTEGER NOT NULL);
      CREATE TABLE nova_transactions (
        tx_id TEXT PRIMARY KEY, status TEXT NOT NULL, amount INTEGER NOT NULL,
        fee INTEGER NOT NULL, created_at INTEGER DEFAULT (strftime('%s','now'))
      );
    `);
  });

  afterEach(() => {
    db.close();
    if (originalEvolutionLearningContextFlag === undefined) {
      delete process.env.NCO_EVOLUTION_LEARNING_EVIDENCE_CONTEXT;
    } else {
      process.env.NCO_EVOLUTION_LEARNING_EVIDENCE_CONTEXT =
        originalEvolutionLearningContextFlag;
    }
  });

  it('reads team tasks, reports, agent performance, and metrics from SQLite', () => {
    db.prepare('INSERT INTO teams (id, slug, lead) VALUES (?, ?, ?)')
      .run('team_analytics', 'analytics-lead', 'codex');
    const insertTask = db.prepare('INSERT INTO tasks (id, team_id, status) VALUES (?, ?, ?)');
    insertTask.run('task-1', 'team_analytics', 'completed');
    insertTask.run('task-2', 'team_analytics', 'failed');
    insertTask.run('task-3', 'team_analytics', 'running');
    db.prepare('INSERT INTO work_reports (id, team_id, report_date, status) VALUES (?, ?, date(\'now\'), ?)')
      .run('report-1', 'team_analytics', 'submitted');
    db.prepare(`
      INSERT INTO agent_performance_summary
        (agent_id, task_type, total_runs, success_rate, avg_quality, avg_duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('codex', 'general', 10, 0.8, 91.5, 1200);
    db.prepare('INSERT INTO metrics (agent_id, metric_type, value) VALUES (?, ?, ?)')
      .run('codex', 'latency_ms', 250);

    const context = buildTeamDataContext('team_analytics', db, () => []);

    expect(context).toContain('[tasks] 최근 7일: 전체=3, 완료=1, 실패성=1, 진행=1, 완료율=33.3%');
    expect(context).toContain('[work_reports] 최근 7일: submitted=1');
    expect(context).toContain('[agent_performance_summary] codex/general: 실행=10, 성공률=80.0%');
    expect(context).toContain('[metrics] codex/latency_ms: 표본=1, 평균=250');
  });

  it('reads CFO wallet and transaction aggregates from existing economy tables', () => {
    db.prepare('INSERT INTO teams (id, slug, lead) VALUES (?, ?, NULL)').run('team_cfo', 'cfo');
    db.prepare('INSERT INTO nova_wallets (address, balance, locked) VALUES (?, ?, ?)').run('did:1', 500, 50);
    db.prepare('INSERT INTO nova_wallets (address, balance, locked) VALUES (?, ?, ?)').run('did:2', 300, 0);
    db.prepare('INSERT INTO nova_transactions (tx_id, status, amount, fee) VALUES (?, ?, ?, ?)')
      .run('tx-1', 'confirmed', 40, 2);

    const context = buildTeamDataContext('team_cfo', db, () => []);

    expect(context).toContain('[nova_wallets] 지갑=2, 총잔액=800, 잠금=50');
    expect(context).toContain('[nova_transactions] 최근 7일/confirmed: 건수=1, 금액=40, 수수료=2');
  });

  it('uses git command output supplied for ax-docs without inventing entries', () => {
    db.prepare('INSERT INTO teams (id, slug, lead) VALUES (?, ?, NULL)').run('team_docs', 'ax-docs');
    const gitLines = ['[git] 최근 커밋:\nabc1234|2026-07-22T00:00:00+09:00|docs update'];

    expect(buildTeamDataContext('team_docs', db, () => gitLines)).toBe(gitLines[0]);
  });

  it('injects only supplied local blog evidence for the three SNS teams', () => {
    const snsEvidence = [
      '[blog-promo] 최근 처리 글 URL=https://nova-money-hub.blogspot.com/example',
      '[blog-promo] 로컬 산출물=2026-07-23.md, 수정=2026-07-23T00:00:00.000Z, 제목=홍보 패키지',
    ];

    for (const [id, slug] of [
      ['team_content', 'content-planning'],
      ['team_sns', 'sns'],
      ['team_quality', 'quality-audit'],
    ]) {
      db.prepare('INSERT INTO teams (id, slug, lead) VALUES (?, ?, NULL)').run(id, slug);
      const context = buildTeamDataContext(id, db, () => [], () => snsEvidence);
      expect(context).toContain(snsEvidence[0]);
      expect(context).toContain(snsEvidence[1]);
    }
  });

  it('injects self-improvement task, note, and git evidence from real source adapters', () => {
    db.prepare('INSERT INTO teams (id, slug, lead) VALUES (?, ?, NULL)')
      .run('team_self', 'self-improvement');
    db.prepare('INSERT INTO tasks (id, team_id, status) VALUES (?, ?, ?)')
      .run('task-fix', 'team_self', 'completed');
    db.prepare(`
      INSERT INTO improvement_notes
        (id, category, problem, root_cause, fix, verified_at, agent, severity)
      VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)
    `).run('note-1', 'tooling', '보고 데이터 부족', '소스 미주입', '실데이터 로더 추가', 'codex', 'high');
    const gitLines = ['[git] 최근 커밋:\nabc1234|2026-07-23T00:00:00+09:00|context fix'];

    const context = buildTeamDataContext('team_self', db, () => gitLines, () => []);

    expect(context).toContain('[recent_team_task] id=task-fix, 상태=completed');
    expect(context).toContain('[improvement_notes] 전체=1, 최근 7일=1');
    expect(context).toContain('문제=보고 데이터 부족');
    expect(context).toContain(gitLines[0]);
  });

  it('reports zero self-improvement notes without inventing note content', () => {
    db.prepare('INSERT INTO teams (id, slug, lead) VALUES (?, ?, NULL)')
      .run('team_self_empty', 'self-improvement');

    const context = buildTeamDataContext('team_self_empty', db, () => [], () => []);

    expect(context).toContain('[improvement_notes] 전체=0, 최근 7일=0, 최근기록=없음');
    expect(context).not.toContain('[improvement_note]');
  });

  it('injects bounded task and linked event evidence for evolution learning', () => {
    process.env.NCO_EVOLUTION_LEARNING_EVIDENCE_CONTEXT = '1';
    db.prepare('INSERT INTO teams (id, slug, lead) VALUES (?, ?, NULL)')
      .run('team_learning', 'gov-evolution-learning');
    const insertTask = db.prepare(`
      INSERT INTO tasks (
        id, team_id, status, prompt, response, error, result_json,
        evidence_json, metadata_json, created_at, completed_at
      )
      VALUES (
        ?, 'team_learning', ?, ?, ?, ?, ?, ?, ?,
        datetime('now', ?), datetime('now', ?)
      )
    `);
    insertTask.run(
      'task-newest', 'completed', '최신 지시', '검증됐다고 주장',
      null, '{"outcome":"saved"}', '[{"tier":"T1"}]', '{"workReportId":"wr-1"}',
      '-1 hour', '-30 minutes',
    );
    insertTask.run(
      'task-empty', 'failed', '공백 실패', ' \n ', 'silent-failure: empty output',
      null, null, null, '-2 hours', '-90 minutes',
    );
    for (let index = 3; index <= 6; index += 1) {
      insertTask.run(
        `task-${index}`, 'completed', `지시 ${index}`, `응답 ${index}`,
        null, null, null, null, `-${index} hours`, `-${index} hours`,
      );
    }
    insertTask.run(
      'task-too-old', 'failed', '오래된 지시', null, 'old failure',
      null, null, null, '-49 hours', '-49 hours',
    );
    db.prepare(`
      INSERT INTO tasks (id, team_id, status, prompt, created_at)
      VALUES ('task-running', 'team_learning', 'running', '진행 중', datetime('now'))
    `).run();

    db.prepare(`
      INSERT INTO learning_events
        (agent_id, event_type, pattern, context, auto_applied)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'codex',
      'failover_dispatch',
      null,
      '{"taskId":"retry-1","sourceTaskId":"task-empty","retryCount":1}',
      0,
    );
    db.prepare(`
      INSERT INTO learning_events
        (agent_id, event_type, pattern, context, auto_applied)
      VALUES (?, ?, ?, ?, ?)
    `).run('codex', 'escalation', null, '{"taskId":"unrelated"}', 0);

    const context = buildTeamDataContext('team_learning', db, () => []);

    expect(context.match(/\[learning_task_evidence\]/g)).toHaveLength(5);
    expect(context).toContain('id=task-newest');
    expect(context).toContain('응답(T4-natural-language)=검증됐다고 주장');
    expect(context).toContain('result_json={"outcome":"saved"}');
    expect(context).toContain('evidence_json=[{"tier":"T1"}]');
    expect(context).toContain('workReportId=wr-1');
    expect(context).toContain('id=task-empty');
    expect(context).toContain('오류=silent-failure: empty output');
    expect(context).toContain('응답(T4-natural-language)=공백');
    expect(context).not.toContain('id=task-6,');
    expect(context).not.toContain('task-too-old');
    expect(context).not.toContain('task-running');
    expect(context).toContain('[learning_event_evidence]');
    expect(context).toContain('"sourceTaskId":"task-empty"');
    expect(context).not.toContain('"taskId":"unrelated"');
  });

  it('keeps evolution learning evidence reversible and other team context unchanged', () => {
    db.prepare('INSERT INTO teams (id, slug, lead) VALUES (?, ?, NULL)')
      .run('team_learning', 'gov-evolution-learning');
    db.prepare('INSERT INTO teams (id, slug, lead) VALUES (?, ?, NULL)')
      .run('team_other', 'analytics');
    const insert = db.prepare(`
      INSERT INTO tasks (id, team_id, status, prompt, response)
      VALUES (?, ?, 'completed', '실제 지시', '내부 자연어 주장')
    `);
    insert.run('learning-task', 'team_learning');
    insert.run('other-task', 'team_other');

    process.env.NCO_EVOLUTION_LEARNING_EVIDENCE_CONTEXT = '0';
    const disabledContext = buildTeamDataContext('team_learning', db, () => []);
    process.env.NCO_EVOLUTION_LEARNING_EVIDENCE_CONTEXT = '1';
    const otherContext = buildTeamDataContext('team_other', db, () => []);

    expect(disabledContext).not.toContain('[learning_task_evidence]');
    expect(disabledContext).not.toContain('내부 자연어 주장');
    expect(otherContext).not.toContain('[learning_task_evidence]');
    expect(otherContext).not.toContain('내부 자연어 주장');
  });

  it('states the honest fallback when a team has no available data', () => {
    db.prepare('INSERT INTO teams (id, slug, lead) VALUES (?, ?, NULL)').run('team_empty', 'empty-team');

    expect(buildTeamDataContext('team_empty', db, () => [])).toBe(
      '데이터 없음\n가용 데이터 없음 — 지어내지 말고 그대로 보고.',
    );
  });

  it('injects the real-data section and non-silent response rule into report prompts', () => {
    const prompt = buildReportPrompt(
      {
        id: 'team_empty', organization_id: null, name: 'Empty Team', slug: 'empty-team',
        lead: null, charter: null, is_active: 1,
      },
      '2026-07-22',
      'pm',
      {
        organizationId: null, teamId: 'team_empty', orgRootId: null, orgParentId: null,
        orgPath: 'nco/empty-team', orgDepth: 1, unitLevel: 'team', active: true,
      },
      '데이터 없음\n가용 데이터 없음 — 지어내지 말고 그대로 보고.',
    );

    expect(prompt).toContain('[실데이터]\n데이터 없음');
    expect(prompt).toContain('없는 수치·사건·완료 상태를 지어내지 않는다');
    expect(prompt).toContain('데이터가 없더라도 빈 응답을 내지 말고');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { CompanyRun, RunStage } from '../../core/company-orchestrator.js';
import { buildHarnessReport } from './harness.js';

function stage(status: RunStage['status'], overrides: Partial<RunStage> = {}): RunStage {
  return {
    teamId: `team-${status}`,
    teamSlug: `team-${status}`,
    teamName: `Team ${status}`,
    rank: 1,
    executor: 'codex',
    subtask: 'test',
    taskId: `task-${status}`,
    status,
    ...overrides,
  };
}

function companyRun(
  status: CompanyRun['status'],
  stages: RunStage[],
  overrides: Partial<CompanyRun> = {},
): CompanyRun {
  return {
    id: 'corun-test',
    orgId: 'org-test',
    orgName: 'Test',
    orgSlug: 'test',
    goal: 'finish reliably',
    mode: 'pipeline',
    status,
    dryRun: false,
    projectDir: '/tmp/test',
    maxIterations: 5,
    completedIterations: 0,
    resumeCount: 0,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:01:00.000Z',
    decomposer: 'codex',
    decomposeSource: 'llm',
    stages,
    ...overrides,
  };
}

const row = {
  id: 'harness-test',
  requirement: 'finish reliably',
  organization: 'nco-engineering',
  mode: 'pipeline' as const,
  company_run_id: 'corun-test',
  config_json: '{"maxIterations":5}',
  created_at: '2026-07-26T00:00:00.000Z',
};

describe('durable harness report', () => {
  it('reports convergence only when every stage reached a verified terminal success', () => {
    const report = buildHarnessReport(
      row,
      companyRun('completed', [stage('completed'), stage('completed')], { iteration: 2 }),
      '2026-07-26T00:02:00.000Z',
    );

    expect(report).toMatchObject({
      status: 'completed',
      converged: true,
      completionScore: 100,
      totalIterations: 2,
      terminationReason: 'all_stages_verified',
    });
  });

  it('fail-closes after injected stage failure and exposes the evidence', () => {
    const report = buildHarnessReport(
      row,
      companyRun('partial', [
        stage('completed'),
        stage('failed', { error: 'provider unavailable', attempt: 3, retryCount: 1 }),
      ], {
        iteration: 5,
        error: 'loop budget exhausted',
      }),
      '2026-07-26T00:05:00.000Z',
    );

    expect(report).toMatchObject({
      status: 'partial',
      converged: false,
      completionScore: 50,
      totalIterations: 5,
      terminationReason: 'loop budget exhausted',
    });
    expect(report.stages[1]).toMatchObject({
      status: 'failed',
      attempt: 3,
      retries: 1,
      error: 'provider unavailable',
    });
  });

  it('keeps a recovered nonterminal run nonterminal instead of claiming success', () => {
    const report = buildHarnessReport(
      row,
      companyRun('running', [stage('completed'), stage('running')], { iteration: 3 }),
      '2026-07-26T00:03:00.000Z',
    );

    expect(report.status).toBe('running');
    expect(report.converged).toBe(false);
    expect(report.completedAt).toBeNull();
  });

  it('does not claim convergence when a safety policy skipped downstream work', () => {
    const report = buildHarnessReport(
      row,
      companyRun('completed', [stage('completed'), stage('skipped')], { iteration: 1 }),
      '2026-07-26T00:01:00.000Z',
    );

    expect(report.status).toBe('partial');
    expect(report.converged).toBe(false);
    expect(report.completionScore).toBe(50);
  });

  it('keeps durable terminal timestamps stable when the report is read again', () => {
    const report = buildHarnessReport(
      {
        ...row,
        status: 'completed' as const,
        updated_at: '2026-07-26T00:02:00.000Z',
        completed_at: '2026-07-26T00:02:00.000Z',
      },
      companyRun('completed', [stage('completed')], { iteration: 1 }),
      '2026-07-26T01:00:00.000Z',
    );

    expect(report.updatedAt).toBe('2026-07-26T00:02:00.000Z');
    expect(report.completedAt).toBe('2026-07-26T00:02:00.000Z');
  });
});

describe('090 durable orchestration migration', () => {
  it('creates both durable run stores and the legacy-compatible report store', () => {
    const db = new Database(':memory:');
    const sql = readFileSync(
      resolve(process.cwd(), 'db/migrations/090_durable_harness_runs.sql'),
      'utf8',
    );
    db.exec(sql);
    db.exec(sql);

    const names = (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name IN ('company_runs','harness_runs','harness_reports')
      ORDER BY name
    `).all() as Array<{ name: string }>).map((entry) => entry.name);
    expect(names).toEqual(['company_runs', 'harness_reports', 'harness_runs']);
    db.close();
  });
});

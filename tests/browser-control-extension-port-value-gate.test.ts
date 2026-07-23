import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const reportRoot = 'REPORTS/technology-porting/browser-control-extension-port-value-gate';
const artifactPath = `${reportRoot}/artifact.json`;
const htmlPath = `${reportRoot}/report.html`;
const notesPath = `${reportRoot}/source-notes.md`;
const receiptPath = `${reportRoot}/evidence/report-delivery-receipt.json`;
const teamReportPath =
  'data/team-runner/team_tech-port-07-value-gate-report-2026-07-23.md';

type ValueGate = {
  gate: string;
  status: string;
};

type ReportArtifact = {
  manifest: {
    title: string;
    blocks: Array<{ id: string; body?: string }>;
  };
  snapshot: {
    datasets: {
      value_gates: ValueGate[];
    };
  };
};

describe('browser-control P1~P4 value-gate report', () => {
  it('keeps the conditional implementation decision separate from release approval', async () => {
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as ReportArtifact;
    const summary = artifact.manifest.blocks.find(
      (block) => block.id === 'technical-summary',
    )?.body;

    expect(artifact.manifest.title).toBe('브라우저 제어 P1~P4 이식 가치판단 보고서');
    expect(summary).toContain('CONDITIONAL_GO_IMPLEMENTATION');
    expect(summary).toContain('NO_GO_MERGE_RELEASE');

    const gates = artifact.snapshot.datasets.value_gates;
    expect(gates.map(({ gate }) => gate)).toEqual([
      '안전',
      '복구 가능성',
      '기능 향상',
      '성능 향상·저하',
      '유지보수 비용',
      '라이선스',
      '세 프로젝트 적합성',
    ]);
    expect(gates.find(({ gate }) => gate === '성능 향상·저하')?.status).toBe('UNKNOWN');
    expect(gates.find(({ gate }) => gate === '기능 향상')?.status).toBe(
      'HIGH POTENTIAL / NOT REALIZED',
    );
  });

  it('renders the canonical decision and does not restore unsupported claims', async () => {
    const [artifactText, html, teamReport] = await Promise.all([
      readFile(artifactPath, 'utf8'),
      readFile(htmlPath, 'utf8'),
      readFile(teamReportPath, 'utf8'),
    ]);

    expect(html).toContain('브라우저 제어 P1~P4 이식 가치판단 보고서');
    expect(html).toContain('성능 향상·저하');
    expect(teamReport).toContain('PORT_DECISION: CONDITIONAL_GO_IMPLEMENTATION');
    expect(teamReport).toContain('MERGE_RELEASE_DECISION: NO_GO');
    expect(teamReport).toContain('P4_ACTIVATION_DECISION: NO_GO');
    expect(artifactText).not.toContain('향상 (오버헤드 감소)');
    expect(artifactText).not.toContain('라이선스 충돌 요소가 없');
  });

  it('records structural-only delivery in the non-empty receipt', async () => {
    const [receiptText, notes, receiptStats] = await Promise.all([
      readFile(receiptPath, 'utf8'),
      readFile(notesPath, 'utf8'),
      stat(receiptPath),
    ]);
    const receipt = JSON.parse(receiptText) as {
      ok: boolean;
      stages: { verification: string };
      browserWarning: { code: string; message: string };
    };

    expect(receiptStats.size).toBeGreaterThan(0);
    expect(receipt.ok).toBe(true);
    expect(receipt.stages.verification).toBe('structural_only');
    expect(receipt.browserWarning.code).toBe('browser_unavailable');
    expect(receipt.browserWarning.message).toContain(
      'Configured Chromium executable does not exist',
    );
    expect(notes).toContain('evidence/report-delivery-receipt.json');
    expect(notes).not.toContain('report-delivery-browser-failure.json');
  });
});

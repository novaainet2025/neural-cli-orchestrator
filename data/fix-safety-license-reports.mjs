#!/usr/bin/env node
import { readFileSync } from 'fs';

const TEAM = 'team_tech-port-02-safety-license';

async function main() {
  const missed = [];

  for (const { date, slot } of [
    { date: '2026-07-25', slot: 'pm' },
    { date: '2026-07-26', slot: 'am' },
  ]) {
    const url = `http://localhost:6200/api/work-reports?date=${date}&slot=${slot}&status=missed`;
    const res = await fetch(url);
    const data = await res.json();
    const report = (data.reports || []).find(
      (r) => r.subjectId === TEAM || r.teamId === TEAM,
    );
    if (report) missed.push({ ...report, date, slot });
  }

  console.log('MISSED:', JSON.stringify(missed.map((r) => ({ id: r.id, date: r.reportDate, slot: r.reportSlot }))));

  for (const report of missed) {
    const file = `/Users/nova-ai/project/nco/data/team-runner/${TEAM}-${report.date}.md`;
    const bodyMd = readFileSync(file, 'utf8');
    const submitRes = await fetch(
      `http://localhost:6200/api/work-reports/${report.id}/submit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Safety License daily report',
          bodyMd,
        }),
      },
    );
    const submitData = await submitRes.json();
    console.log(
      `SUBMIT ${report.id}: status=${submitRes.status}`,
      JSON.stringify({
        id: submitData.report?.id,
        status: submitData.report?.status,
        error: submitData.error,
      }),
    );
  }

  // Verify counts via API range if possible, else note for sqlite
  for (const { date, slot } of [
    { date: '2026-07-25', slot: 'pm' },
    { date: '2026-07-26', slot: 'am' },
  ]) {
    const url = `http://localhost:6200/api/work-reports?date=${date}&slot=${slot}`;
    const res = await fetch(url);
    const data = await res.json();
    const report = (data.reports || []).find(
      (r) => r.subjectId === TEAM || r.teamId === TEAM,
    );
    if (report) {
      console.log(`VERIFY ${date} ${slot}:`, report.status, report.id);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

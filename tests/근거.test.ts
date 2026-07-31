import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const reportPath = 'data/team-runner/team_ax-collab-2026-07-13.md';

// ax-collab 은 마이그레이션 093(team_successor_topology)으로 퇴역했고 승계 팀은
// team_ax-decision-coordination-2026 이다. team-runner 는 퇴역 팀을 순회하지 않으므로
// team_ax-collab.last 는 2026-07-26 이후 영원히 갱신되지 않는다 — 그 파일을 "오늘"과
// 비교하면 날짜가 넘어가는 순간부터 매일 실패한다. 포인터 최신성 검사는 실제로 매일
// 도는 승계 팀을 대상으로 해야 의미가 있다.
const pointerPath = 'data/team-runner/team_ax-decision-coordination-2026.last';

describe('근거', () => {
  it('오후 보고서 파일에 필수 본문이 있다', async () => {
    const report = await readFile(reportPath, 'utf8');

    expect(report).toContain('# 2026년 7월 13일 오후 보고서');
    expect(report).toContain('## 오늘 수행한 핵심 업무');
    expect(report).toContain('## 진행 중 이슈');
    expect(report).toContain('## 다음 액션');
    expect(report).toContain('`ax-collab`');
  });

  it('승계 팀(Decision & Coordination Office)의 최신 포인터가 최신 산출물을 가리킨다', async () => {
    const pointer = await readFile(pointerPath, 'utf8');
    const reportPrefix = 'team_ax-decision-coordination-2026-';
    const reportDates = (await readdir('data/team-runner'))
      .filter(name => name.startsWith(reportPrefix) && name.endsWith('.md'))
      .map(name => name.slice(reportPrefix.length, -3))
      .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value))
      .sort();

    expect(reportDates.length).toBeGreaterThan(0);
    expect(pointer.trim()).toBe(reportDates.at(-1));
  });
});

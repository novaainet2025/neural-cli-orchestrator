import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const reportPath = 'data/team-runner/team_ax-research-2026-07-13.md';
const pointerPath = 'data/team-runner/team_ax-research.last';

describe('근거', () => {
  it('오전 보고서 파일에 필수 본문이 있다', async () => {
    const report = await readFile(reportPath, 'utf8');

    expect(report).toContain('# 2026년 7월 13일 오전 보고서');
    expect(report).toContain('## 오늘 수행한 핵심 업무');
    expect(report).toContain('## 진행 중 이슈');
    expect(report).toContain('## 다음 액션');
    expect(report).toContain('`ax-research`');
  });

  it('최신 포인터가 오늘 날짜를 가리킨다', async () => {
    const pointer = await readFile(pointerPath, 'utf8');
    expect(pointer.trim()).toBe('2026-07-13');
  });
});

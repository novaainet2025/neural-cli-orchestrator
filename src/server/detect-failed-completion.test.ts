import { describe, expect, it } from 'vitest';
import { classifyResult } from '../core/task-queue.js';
import { detectFailedCompletion, isTextReportTask } from './gateway.js';

/**
 * detectFailedCompletion 회귀 테스트 (2026-07-16).
 * 실데이터 근거: 2일간 failure-pattern 마킹 7건 중 4건이 'done:'로 시작하는 오탐이었다
 * (보안·에러핸들링 태스크의 정상 응답에 401/403/'usage limit'/'error:' 어휘가 필연 등장).
 * 아래 케이스는 그 실데이터 형태를 반영한다.
 */
describe('detectFailedCompletion', () => {
  it('done: 성공 프로토콜은 본문에 에러 어휘가 있어도 실패로 보지 않는다 (오탐 방지)', () => {
    expect(detectFailedCompletion(
      "done: [Evidence Tier 1] 401/403 unauthorized 처리와 usage limit 가드를 구현했습니다. error: 케이스 전부 커버.",
    )).toBe(false);
    expect(detectFailedCompletion(
      'done: `src/doctor.ts` 연결 진단을 원인별로 세분화. timeout/refused/exceeded 각각 분기.',
    )).toBe(false);
  });

  it('error: 실패 프로토콜과 원시 에러는 실패로 판정한다 (진짜 실패 유지)', () => {
    expect(detectFailedCompletion('error: 전체 Vitest 검증 기준을 충족하지 못했습니다.')).toBe(true);
    expect(detectFailedCompletion('error: Unsupported shell metacharacter in command')).toBe(true);
    expect(detectFailedCompletion('Error: connection refused')).toBe(true);
  });

  it('소스코드/상태 브리프 에코 라인은 실패 신호로 보지 않는다 (에코-FP 방어)', () => {
    expect(detectFailedCompletion(
      "변경 요약\nconst QUOTA_RE = /usage limit|quota exceeded/i;\n적용 완료",
    )).toBe(false);
  });

  it('빈 응답은 실패가 아니다', () => {
    expect(detectFailedCompletion('')).toBe(false);
    expect(detectFailedCompletion(null)).toBe(false);
  });

  it('보고형 태스크는 에러 어휘가 있는 정상 본문을 실패로 보지 않는다', () => {
    const reportMode = isTextReportTask({
      mode: 'task',
      prompt: '[업무보고 작성] 오전 보고서를 작성하라.',
      team_id: 'team-cli-core',
    });

    expect(reportMode).toBe(true);
    expect(isTextReportTask({ mode: 'work_report', prompt: '정기 현황을 작성하라.' })).toBe(true);
    expect(isTextReportTask({ mode: 'task', prompt: '[팀 상시 임무 — CLI 코어]' })).toBe(true);
    expect(detectFailedCompletion(
      '오늘 배포가 failed to start 상태였고 usage limit 원인을 분석했습니다.',
      { reportMode },
    )).toBe(false);
  });

  it('보고형 태스크도 빈 출력은 silent-failure로 유지한다', () => {
    const result = classifyResult({ success: true, output: '' });

    expect(result).toMatchObject({
      success: false,
      error: 'silent-failure: empty output',
    });
  });

  it('비보고형 태스크는 에러 어휘를 기존대로 실패로 판정한다', () => {
    const reportMode = isTextReportTask({ mode: 'task', prompt: '배포 작업을 수행하라.' });

    expect(reportMode).toBe(false);
    expect(detectFailedCompletion('Deployment failed to start.', { reportMode })).toBe(true);
  });

  it('보고형 태스크도 HARD 시그니처는 실패로 판정한다', () => {
    expect(detectFailedCompletion('Provider connection refused', { reportMode: true })).toBe(true);
  });
});

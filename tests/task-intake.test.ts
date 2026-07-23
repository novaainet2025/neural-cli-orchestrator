import { describe, expect, it } from 'vitest';
import { buildDefaultVerifierWithFs, isStructuredOutputPrompt } from '../src/server/task-intake.js';

const DOC_EDIT_PROMPT = [
  '문서 특화 편집 규칙:',
  '- 최소 변경: 지시된 부분만 수정, 무관한 내용 훼손 금지.',
  '[편집 지시] "폰트 변경"',
  '[출력형식] 오직 JSON 배열만. 코드펜스·설명 없이 JSON 배열만.',
].join('\n');

describe('task intake verifier attachment', () => {
  it('detects structured-output prompts', () => {
    expect(isStructuredOutputPrompt(DOC_EDIT_PROMPT)).toBe(true);
    expect(isStructuredOutputPrompt('버그 수정하고 빌드 통과시켜줘')).toBe(false);
  });

  it('skips build verifier for JSON-only document edit prompts (docs-ai edit-loop regression)', () => {
    // 편집 규칙의 "수정"이 CODE_WORK로 오분류되어 verifier가 붙고
    // JSON 배열 응답이 FORMAT_MISMATCH로 무한 반려된 결함 회귀 방지 (실측 2026-07-19)
    const verifier = buildDefaultVerifierWithFs(
      { prompt: DOC_EDIT_PROMPT, metadata: { projectDir: '/tmp/docs-ai' } },
      () => true,
    );
    expect(verifier).toBeUndefined();
  });

  it('still attaches build verifier for ordinary code work prompts', () => {
    const verifier = buildDefaultVerifierWithFs(
      { prompt: '로그인 버그 수정해줘', metadata: { projectDir: '/tmp/app' } },
      () => true,
    );
    expect(verifier).toEqual({ type: 'run', command: 'npm run build', timeoutMs: 120_000 });
  });
});
